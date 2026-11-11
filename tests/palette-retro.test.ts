import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startDaemon } from "../src/server/daemon.ts";
import { createFakeAgentRunner } from "../src/server/fake-agent.ts";
import type { AgentRunner, AgentSpec } from "../src/server/agent-runner.ts";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

async function boot() {
  const dir = mkdtempSync(join(tmpdir(), "bridge-palette-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const repo = join(dir, "repo");
  mkdirSync(repo, { recursive: true });
  const specs: AgentSpec[] = [];
  const fake = createFakeAgentRunner([]);
  const runner: AgentRunner = { ...fake, start(spec, emit) { specs.push(spec); fake.start(spec, emit); } };
  const daemon = await startDaemon({ dataDir: join(dir, "data"), runner });
  cleanups.push(() => daemon.close().catch(() => {}));
  const post = async (path: string, body: unknown) => {
    const r = await fetch(daemon.url + path, { method: "POST", body: JSON.stringify(body) });
    return { status: r.status, json: (await r.json()) as any };
  };
  const get = async (path: string) => (await fetch(daemon.url + path)).json() as Promise<any>;
  const project = (await post("/api/projects", { name: "demo", path: repo })).json;
  return { repo, specs, post, get, project };
}

describe("command palette quick actions", () => {
  it("lists the six actions with the skill each one runs", async () => {
    const { get } = await boot();
    const actions = await get("/api/quick-actions");
    expect(actions.map((a: any) => a.id)).toEqual(["architecture", "diagnose", "research", "prototype", "triage", "handoff"]);
    for (const a of actions) expect(a.label && a.description && a.skill).toBeTruthy();
  });

  it("starts a normal agent whose task names the skill and carries the user's context", async () => {
    const { post, get, specs, project } = await boot();
    const r = await post(`/api/projects/${project.id}/quick-actions`, { action: "diagnose", context: "login 500s" });
    expect(r.status).toBe(201);
    expect(specs.at(-1)!.task).toContain("mattpocock-skills:diagnosing-bugs");
    expect(specs.at(-1)!.task).toContain("login 500s");
    expect(specs.at(-1)!.task).not.toContain("\n");
    const agent = (await get("/api/agents")).find((a: any) => a.id === r.json.id);
    expect(agent.lead).toBeFalsy();
    expect(agent.ticketId).toBeNull();
    expect(agent.name).toBe("Diagnose a bug");
  });

  it("rejects unknown actions and unknown projects", async () => {
    const { post, project } = await boot();
    expect((await post(`/api/projects/${project.id}/quick-actions`, { action: "nope" })).status).toBe(400);
    expect((await post(`/api/projects/zzz/quick-actions`, { action: "diagnose" })).status).toBe(404);
  });
});
