import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startDaemon } from "../src/server/daemon.ts";
import { createFakeAgentRunner } from "../src/server/fake-agent.ts";
import type { AgentEvent } from "../src/server/agent-runner.ts";

const script: AgentEvent[] = [
  { type: "status", status: "working" },
  { type: "question", text: "Which database?" },
  { type: "status", status: "done" },
];

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

async function boot() {
  const dir = mkdtempSync(join(tmpdir(), "bridge-test-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const daemon = await startDaemon({ dataDir: dir, runner: createFakeAgentRunner(script) });
  cleanups.push(() => daemon.close());
  return { daemon, dir };
}

const post = (url: string, body: unknown) =>
  fetch(url, { method: "POST", body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, json: (await r.json()) as any }));

describe("walking skeleton via the public API", () => {
  it("runs a scripted agent, streams events over WebSocket and persists state", async () => {
    const { daemon, dir } = await boot();
    const ws = new WebSocket(daemon.url.replace("http", "ws") + "/ws");
    const received: any[] = [];
    await new Promise((r) => ws.addEventListener("open", r, { once: true }));
    ws.addEventListener("message", (m) => received.push(JSON.parse(String(m.data))));

    const project = await post(`${daemon.url}/api/projects`, { name: "demo", path: "demo-repo" });
    expect(project.status).toBe(201);
    const agent = await post(`${daemon.url}/api/agents`, { projectId: project.json.id, name: "Atlas" });
    expect(agent.status).toBe(201);

    await expect.poll(() => received.filter((m) => m.type === "agent-event").length).toBe(3);
    ws.close();

    const agents = (await (await fetch(`${daemon.url}/api/agents`)).json()) as any[];
    expect(agents).toEqual([expect.objectContaining({ name: "Atlas", status: "done" })]);
    const events = (await (await fetch(`${daemon.url}/api/agents/${agent.json.id}/events`)).json()) as any[];
    expect(events.map((e) => e.event.type)).toEqual(["status", "question", "status"]);

    // State survives a restart on the same data directory.
    await daemon.close();
    cleanups.splice(cleanups.length - 1, 1); // drop the first daemon's close; keep rmSync registered first
    const again = await startDaemon({ dataDir: dir, runner: createFakeAgentRunner([]) });
    cleanups.push(() => again.close());
    const projects = (await (await fetch(`${again.url}/api/projects`)).json()) as any[];
    expect(projects.map((p) => p.name)).toEqual(["demo"]);
  });

  it("rejects an agent for an unknown project", async () => {
    const { daemon } = await boot();
    const r = await post(`${daemon.url}/api/agents`, { projectId: "nope", name: "X" });
    expect(r.status).toBe(404);
  });
});
