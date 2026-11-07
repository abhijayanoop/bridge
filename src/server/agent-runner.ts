export type AgentStatus = "idle" | "working" | "blocked" | "waiting" | "done";

export type AgentEvent =
  | { type: "status"; status: AgentStatus }
  | { type: "question"; text: string }
  | { type: "access-request"; kind: "domain" | "secret" | "push" | "database"; detail: string };

export interface AgentSpec {
  id: string;
  name: string;
  projectId: string;
}

/** Starts and stops agents and reports what they do. Real adapters (Claude Code in a pty) come later. */
export interface AgentRunner {
  start(spec: AgentSpec, emit: (event: AgentEvent) => void): void;
  stop(agentId: string): void;
}
