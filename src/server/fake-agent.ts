import type { AgentEvent, AgentRunner, AgentSpec } from "./agent-runner.ts";

/**
 * Scripted adapter: replays a fixed list of events asynchronously, in order, unless stopped.
 * Typed input is echoed back as terminal output (`echo: <input>`) so tests can see it arrived.
 */
export function createFakeAgentRunner(script: AgentEvent[]): AgentRunner {
  const stopped = new Set<string>();
  const emitters = new Map<string, (event: AgentEvent) => void>();
  return {
    start(spec: AgentSpec, emit) {
      emitters.set(spec.id, emit);
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
    write(agentId, data) {
      if (stopped.has(agentId)) return;
      emitters.get(agentId)?.({ type: "output", data: `echo: ${data}` });
    },
  };
}
