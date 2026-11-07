import type { AgentEvent, AgentRunner, AgentSpec } from "./agent-runner.ts";

/** Scripted adapter: replays a fixed list of events asynchronously, in order, unless stopped. */
export function createFakeAgentRunner(script: AgentEvent[]): AgentRunner {
  const stopped = new Set<string>();
  return {
    start(spec: AgentSpec, emit) {
      void (async () => {
        for (const event of script) {
          await new Promise((r) => setTimeout(r, 1));
          if (stopped.has(spec.id)) return;
          emit(event);
        }
      })();
    },
    stop(agentId) {
      stopped.add(agentId);
    },
  };
}
