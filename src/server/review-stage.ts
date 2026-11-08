import { randomUUID } from "node:crypto";
import type { AgentRow, Project, Review } from "./db.ts";
import { SEVERITIES, type Finding, type Reviewer } from "./reviewer.ts";
import type { Ticket } from "./tickets.ts";

/** How many times the author is sent back before the user is left to judge what remains. */
export const MAX_REVIEW_ROUNDS = 2;

/** High and medium findings are work to do; low ones are shown to the user only. */
const isBlocking = (f: Finding) => f.severity !== "low";
const bySeverity = (a: Finding, b: Finding) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity);

export interface ReviewStageDeps {
  /** Omitted means no review stage: a finished branch goes straight to its pull request. */
  reviewer?: Reviewer;
  agent(id: string): AgentRow | undefined;
  project(id: string): Project | undefined;
  ticket(project: Project, ticketId: string): Ticket | undefined;
  /** The agent's clone and the commit it branched from. Without both there is nothing to review. */
  cwd(agentId: string): string | undefined;
  base(agentId: string): string | undefined;
  /** True once the user stopped or deleted the agent: it never finished, so it is not reviewed. */
  stopped(agentId: string): boolean;
  reviews(): Review[];
  addReview(review: Review): void;
  updateReview(review: Review): void;
  /** Opens the pull request (or local review item) for a reviewed branch. */
  raise(agentId: string, branch: string): void;
  /** Puts the agent back to work and types the text into its terminal. */
  sendBack(agentId: string, text: string): void;
  say(agentId: string, text: string): void;
  broadcast(message: unknown): void;
  /** A review run ended (so its agent no longer holds a worker slot while it waited). */
  settled(): void;
}

/**
 * Runs the code review when an agent finishes its ticket, before the ticket is ready to merge. A clean review opens
 * the pull request; blocking findings go back to the author as work to do. Bridge only runs the review and
 * routes what it finds: judging and merging stay with the user.
 */
export function createReviewStage(deps: ReviewStageDeps) {
  const inFlight = new Set<string>();
  return {
    /** True while the agent's branch is being reviewed: it still holds its worker slot. */
    busy: (agentId: string) => inFlight.has(agentId),
    /** Call once the agent's branch is in the user's repo and the agent has finished its ticket. */
    afterDone(agentId: string, branch: string): void {
      const { reviewer } = deps;
      const agent = deps.agent(agentId);
      const project = agent && deps.project(agent.projectId);
      const ticket = project && agent.ticketId ? deps.ticket(project, agent.ticketId) : undefined;
      const cwd = deps.cwd(agentId);
      const base = deps.base(agentId);
      if (!reviewer || !agent || !project || !ticket || !cwd || !base) return deps.raise(agentId, branch);
      if (deps.stopped(agentId) || inFlight.has(agentId)) return;
      inFlight.add(agentId);

      const round = deps.reviews().filter((r) => r.agentId === agentId).length + 1;
      let review: Review = {
        id: randomUUID(), agentId, projectId: project.id, ticketKey: agent.ticketKey ?? ticket.key, ticketTitle: agent.ticketTitle ?? ticket.title,
        branch, round, status: "running", findings: [], createdAt: Date.now(),
      };
      deps.addReview(review);
      deps.broadcast({ type: "review", review });
      const finish = (change: Partial<Review>) => {
        review = { ...review, ...change };
        deps.updateReview(review);
        deps.broadcast({ type: "review", review });
      };

      void reviewer.review({ cwd, branch, base, ticketFile: ticket.file })
        .catch((err): { ok: false; reason: string } => ({ ok: false, reason: (err as Error).message }))
        .then((result) => {
          if (!result.ok) {
            finish({ status: "failed", reason: result.reason });
            deps.say(agentId, `Code review could not run: ${result.reason}. Opening the pull request without it.`);
            return deps.raise(agentId, branch);
          }
          const findings = [...result.findings].sort(bySeverity);
          const blocking = findings.filter(isBlocking);
          if (blocking.length === 0) {
            finish({ status: "passed", findings });
            return deps.raise(agentId, branch);
          }
          if (round >= MAX_REVIEW_ROUNDS) {
            finish({ status: "unresolved", findings });
            deps.say(agentId, `After ${round} rounds the review found work that is still open; the pull request is opened for the user to judge.`);
            return deps.raise(agentId, branch);
          }
          finish({ status: "changes-requested", findings });
          const todo = blocking.map((f, i) => `${i + 1}) [${f.axis}/${f.severity}] ${f.summary}${f.file ? ` (${f.file}${f.line ? `:${f.line}` : ""})` : ""}`).join("; ");
          deps.sendBack(agentId, `Code review of your branch found work to do. Fix these, commit, then set your status to done again: ${todo}`);
        })
        .catch((err) => deps.say(agentId, `Code review stage failed: ${(err as Error).message}`))
        .finally(() => { inFlight.delete(agentId); deps.settled(); });
    },
  };
}
