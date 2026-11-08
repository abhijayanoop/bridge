import { randomUUID } from "node:crypto";
import type { AgentRow, Project, Pull } from "./db.ts";
import type { GitHub } from "./github.ts";
import type { Ticket } from "./tickets.ts";

export interface PullRaiserDeps {
  github?: GitHub;
  agent(id: string): AgentRow | undefined;
  project(id: string): Project | undefined;
  ticket(project: Project, ticketId: string): Ticket | undefined;
  /** Contents of a file on a branch of the user's repo. */
  fileAt(projectPath: string, branch: string, file: string): string;
  pulls(): Pull[];
  addPull(pull: Pull): void;
  /** Writes a line into the agent's terminal history. */
  say(agentId: string, text: string): void;
  broadcast(message: unknown): void;
}

/**
 * Opens one pull request per finished ticket through the GitHub port. An agent the user stopped or deleted is
 * never "done", so it gets none. Only opening happens here: merging is the user's.
 */
export function createPullRaiser(deps: PullRaiserDeps) {
  const stopped = new Set<string>();
  const raising = new Set<string>();
  return {
    /** Call before stopping or deleting an agent. */
    userStopped(agentId: string) { stopped.add(agentId); },
    forget(agentId: string) { stopped.delete(agentId); raising.delete(agentId); },
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
          if (!r.ok) { deps.say(agentId, r.skipped ? r.reason : `Could not open a pull request: ${r.reason}`); return; }
          if (!deps.pulls().some((p) => p.url === r.url)) {
            const pull: Pull = { id: randomUUID(), agentId, projectId: project.id, ticketKey: agent.ticketKey!, title, branch, url: r.url, number: r.number, state: "open", createdAt: Date.now() };
            deps.addPull(pull);
            deps.broadcast({ type: "pull", pull });
          }
          deps.say(agentId, `Pull request #${r.number} ${r.existing ? "already exists" : "opened"}: ${r.url}`);
        })
        .catch((err) => deps.say(agentId, `Could not open a pull request: ${(err as Error).message}`))
        .finally(() => raising.delete(agentId));
    },
  };
}

