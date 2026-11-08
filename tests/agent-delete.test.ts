import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { startDaemon } from "../src/server/daemon.ts";
import { createFakeAgentRunner } from "../src/server/fake-agent.ts";
import type { AgentRunner } from "../src/server/agent-runner.ts";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

async function boot(git = false) {
  const dir = mkdtempSync(join(tmpdir(), "bridge-delete-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const repo = join(dir, "repo");
  mkdirSync(join(repo, ".scratch", "f", "issues"), { recursive: true });
  writeFileSync(join(repo, ".scratch", "f", "issues", "01-t.md"), "# 01: T\n\n**Status:** ready-for-agent\n");
  if (git) {
    const g = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: repo, stdio: "ignore" });
    g("init", "-b", "main"); g("add", "-A"); g("commit", "-m", "i");
  }
  const stopped: string[] = [];
  const fake = createFakeAgentRunner([]);
  const runner: AgentRunner = { ...fake, stop(id) { stopped.push(id); fake.stop(id); } };
  const daemon = await startDaemon({ dataDir: join(dir, "data"), runner });
  cleanups.push(() => daemon.close());
  const post = async (p: string, b: unknown) => (await fetch(daemon.url + p, { method: "POST", body: JSON.stringify(b) })).json() as Promise<any>;
  const project = await post("/api/projects", { name: "demo", path: repo });
  const start = (ticket?: string) => post("/api/agents", { projectId: project.id, name: "A", ...(ticket ? { ticket } : {}) });
  const del = (id: string) => fetch(`${daemon.url}/api/agents/${id}`, { method: "DELETE" });
  const list = async () => (await (await fetch(daemon.url + "/api/agents")).json()) as any[];
  return { start, del, list, stopped, dir, daemon };
}

describe("deleting agents via the public API", () => {
  it("removes the agent, its history and stops it", async () => {
    const { start, del, list, stopped, daemon } = await boot();
    const a = await start();
    const b = await start();
    expect((await del(a.id)).status).toBe(200);
    expect((await list()).map((x) => x.id)).toEqual([b.id]);
    expect(stopped).toContain(a.id);
    expect(await (await fetch(`${daemon.url}/api/agents/${a.id}/events`)).json()).toEqual([]);
  });

  it("returns 404 for an unknown or already deleted agent", async () => {
    const { start, del } = await boot();
    const a = await start();
    await del(a.id);
    expect((await del(a.id)).status).toBe(404);
  });

  it("removes the agent's clone but not the working copy", async () => {
    const { start, del, dir } = await boot(true);
    const a = await start("f/01");
    const clone = a.workspace.path as string;
    expect(existsSync(clone)).toBe(true);
    await del(a.id);
    expect(existsSync(clone)).toBe(false);
    expect(existsSync(join(dir, "repo", ".scratch"))).toBe(true);
  });
});
