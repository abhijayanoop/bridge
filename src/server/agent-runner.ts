export type AgentStatus = "idle" | "working" | "blocked" | "waiting" | "done";

export type AgentEvent =
  | { type: "status"; status: AgentStatus }
  | { type: "question"; text: string }
  | { type: "access-request"; kind: "domain" | "secret" | "push" | "database"; detail: string }
  /** Raw terminal bytes (as text, ANSI included) from the agent's pseudo-terminal. */
  | { type: "output"; data: string };

export interface AgentSpec {
  id: string;
  name: string;
  projectId: string;
  /** Working directory: the project's repo. */
  cwd?: string;
  /** Initial task text given to the agent, derived from the ticket. */
  task?: string;
  /** Where the agent reports status (set by the daemon; the token authenticates it). */
  hook?: { url: string; token: string };
}

/** Starts and stops agents and reports what they do. */
export interface AgentRunner {
  start(spec: AgentSpec, emit: (event: AgentEvent) => void): void;
  stop(agentId: string): void;
  /** Sends typed input (keystrokes) to a running agent. Ignored if it is not running. */
  write(agentId: string, data: string): void;
  resize?(agentId: string, cols: number, rows: number): void;
}
