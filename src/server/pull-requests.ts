import { randomUUID } from "node:crypto";
import type { AgentRow, Project, Pull } from "./db.ts";
import type { GitHub } from "./github.ts";
import type { Column, Ticket } from "./tickets.ts";

export interface PullRaiserDeps {
  github?: GitHub;
  agent(id: string): AgentRow | undefined;
  project(id: string): Project | undefined;
  ticket(project: Project, ticketId: string): Ticket | undefined;
  /** Contents of a file on a branch of the user's repo. */
  fileAt(projectPath: string, branch: string, file: string): string;
  pulls(): Pull[];
  addPull(pull: Pull): void;
  updatePull(pull: Pull): void;
  /** Writes a line into the agent's terminal history. */
  say(agentId: string, text: string): void;
  broadcast(message: unknown): void;
  /** Moves the ticket's card by writing its status into the ticket file. */
  setColumn(project: Project, ticketId: string, column: Column): void;
  /** Merges a ticket branch into the user's checked-out branch. Fails without changing anything on conflict or uncommitted work. */
  mergeLocal(project: Project, branch: string, title: string): { ok: true } | { ok: false; reason: string };
  /** The ticket with this key in the project (agents may be deleted by the time a pull request ends). */
  ticketByKey(project: Project, key: string): Ticket | undefined;
}

/**
 * Opens one pull request per finished ticket through the GitHub port. An agent the user stopped or deleted is
 * never "done", so it gets none. Only opening happens here: merging is the user's.
 */
export function createPullRaiser(deps: PullRaiserDeps) {
  const stopped = new Set<string>();
  const raising = new Set<string>();

  /** Records that a pull request ended. A merge moves the ticket's card to Done. */
  function settle(pull: Pull, state: "merged" | "closed") {
    const updated: Pull = { ...pull, state };
    deps.updatePull(updated);
    deps.broadcast({ type: "pull", pull: updated });
    const project = deps.project(pull.projectId);
    const ticket = project && deps.ticketByKey(project, pull.ticketKey);
    if (state === "merged" && project && ticket) deps.setColumn(project, ticket.id, "done");
  }
  return {
    /** Call before stopping or deleting an agent. */
    userStopped(agentId: string) { stopped.add(agentId); },
    wasStopped: (agentId: string) => stopped.has(agentId),
    forget(agentId: string) { stopped.delete(agentId); raising.delete(agentId); },
    /** The user pressed Merge. Nothing else in Bridge merges. */
    async merge(pullId: string): Promise<{ code: number; body: unknown }> {
      const pull = deps.pulls().find((p) => p.id === pullId);
      if (!pull) return { code: 404, body: { error: "unknown pull request" } };
      if (pull.state !== "open") return { code: 409, body: { error: `this pull request is already ${pull.state}` } };
      const project = deps.project(pull.projectId);
      if (!project) return { code: 404, body: { error: "unknown project" } };
      if (pull.local) {
        const r = deps.mergeLocal(project, pull.branch, pull.title);
        if (!r.ok) return { code: 409, body: { error: r.reason } };
        settle(pull, "merged");
        return { code: 200, body: { ...pull, state: "merged" } };
      }
      if (!deps.github) return { code: 502, body: { error: "GitHub is not available" } };
      const r = await deps.github.mergePullRequest({ repoPath: project.path, number: pull.number });
      if (!r.ok) return { code: 502, body: { error: r.reason } };
      settle(pull, "merged");
      return { code: 200, body: { ...pull, state: "merged" } };
    },
    /** Asks GitHub about every open pull request: merged moves its card to Done, closed is recorded. */
    async poll(): Promise<void> {
      const { github } = deps;
      if (!github) return;
      for (const pull of deps.pulls().filter((p) => p.state === "open" && !p.local)) {
        const project = deps.project(pull.projectId);
        if (!project) continue;
        const state = await github.pullState({ repoPath: project.path, number: pull.number }).catch(() => null);
        if (state && state !== "open") settle(pull, state);
      }
    },
    /** Call once the agent's branch is in the user's repo and the agent has finished its ticket. */
    raise(agentId: string, branch: string): void {
      const { github } = deps;
      if (!github || stopped.has(agentId) || raising.has(agentId)) return;
      const agent = deps.agent(agentId);
      const project = agent && deps.project(agent.projectId);
      if (!agent || !project || !agent.ticketKey) return;
      if (deps.pulls().some((p) => p.agentId === agentId)) return;
      raising.add(agentId);

      const title = `${agent.ticketKey}: ${agent.ticketTitle ?? ""}`.trim();
      const ticket = agent.ticketId ? deps.ticket(project, agent.ticketId) : undefined;
      const ticketText = ticket ? deps.fileAt(project.path, branch, ticket.file).trim() : "";
      const body = [
        title,
        ticket ? `Ticket file: ${ticket.file}` : "",
        ticketText ? `\n${ticketText}` : "",
        "\nOpened by Bridge. Review the changes; the user merges.",
      ].filter(Boolean).join("\n");

      void github.createPullRequest({ repoPath: project.path, branch, title, body })
        .then((r) => {
          const record = (extra: Pick<Pull, "url" | "number"> & { local?: boolean }) => {
            const pull: Pull = { id: randomUUID(), agentId, projectId: project.id, ticketKey: agent.ticketKey!, title, branch, state: "open", createdAt: Date.now(), ...extra };
            deps.addPull(pull);
            deps.broadcast({ type: "pull", pull });
            if (agent.ticketId) deps.setColumn(project, agent.ticketId, "review");
          };
          if (!r.ok && r.skipped) {
            // No GitHub remote: the branch itself is what gets reviewed, and merging it locally needs the user's approval.
            record({ url: "", number: 0, local: true });
            deps.say(agentId, `${r.reason}. Merge it locally from the Review screen when you approve.`);
            return;
          }
          if (!r.ok) { deps.say(agentId, `Could not open a pull request: ${r.reason}`); return; }
          if (!deps.pulls().some((p) => p.url === r.url)) record({ url: r.url, number: r.number });
          else if (agent.ticketId) deps.setColumn(project, agent.ticketId, "review");
          deps.say(agentId, `Pull request #${r.number} ${r.existing ? "already exists" : "opened"}: ${r.url}`);
        })
        .catch((err) => deps.say(agentId, `Could not open a pull request: ${(err as Error).message}`))
        .finally(() => raising.delete(agentId));
    },
  };
}

