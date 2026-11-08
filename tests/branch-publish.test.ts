import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startDaemon } from "../src/server/daemon.ts";
import { createFakeAgentRunner } from "../src/server/fake-agent.ts";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" }).trim();

async function boot() {
  const dir = mkdtempSync(join(tmpdir(), "bridge-publish-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const repo = join(dir, "repo");
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(repo, "app.txt"), "hello\n");
  git(repo, "init", "-b", "main"); git(repo, "add", "-A"); git(repo, "commit", "-m", "init");
  // The ticket is written but not committed, as when a ticket was just created.
  mkdirSync(join(repo, ".scratch", "f", "issues"), { recursive: true });
  writeFileSync(join(repo, ".scratch", "f", "issues", "01-add-thing.md"), "# 01: Add thing\n\n**Status:** ready-for-agent\n");
  const daemon = await startDaemon({ dataDir: join(dir, "data"), runner: createFakeAgentRunner([]) });
  cleanups.push(() => daemon.close());
  const call = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(daemon.url + path, { method, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, json: (await r.json()) as any };
  };
  const project = (await call("POST", "/api/projects", { name: "demo", path: repo })).json;
  const start = async () => (await call("POST", "/api/agents", { projectId: project.id, name: "A", ticket: "f/01" })).json;
  return { repo, call, start, daemon };
}

describe("ticket branch and file reach the agent and the user", () => {
  it("an uncommitted ticket file is available in the agent's clone and stays out of its commits", async () => {
    const t = await boot();
    const agent = await t.start();
    const file = join(agent.workspace.path, ".scratch", "f", "issues", "01-add-thing.md");
    expect(readFileSync(file, "utf8")).toContain("Add thing");
    expect(git(agent.workspace.path, "status", "--porcelain")).not.toContain("01-add-thing");
  });

  it("the agent's branch appears in the user's repo when the agent stops, and survives deleting the agent", async () => {
    const t = await boot();
    const agent = await t.start();
    writeFileSync(join(agent.workspace.path, "hello.py"), "print('hi')\n");
    git(agent.workspace.path, "add", "hello.py"); git(agent.workspace.path, "commit", "-m", "Add hello.py");
    expect(git(t.repo, "branch", "--list", agent.workspace.branch)).toBe("");

    await t.call("POST", `/api/agents/${agent.id}/stop`, {});
    expect(git(t.repo, "log", "--format=%s", "-1", agent.workspace.branch)).toBe("Add hello.py");
    // The user's working copy is untouched: still on main, without the agent's file.
    expect(git(t.repo, "branch", "--show-current")).toBe("main");
    expect(existsSync(join(t.repo, "hello.py"))).toBe(false);
    const events = JSON.stringify((await t.call("GET", `/api/agents/${agent.id}/events`)).json);
    expect(events).toContain(`Branch ${agent.workspace.branch} is now in your repo`);

    await t.call("DELETE", `/api/agents/${agent.id}`);
    expect(existsSync(agent.workspace.path)).toBe(false);
    expect(git(t.repo, "log", "--format=%s", "-1", agent.workspace.branch)).toBe("Add hello.py");
  });

  it("deleting an agent that never stopped still keeps its commits as a branch", async () => {
    const t = await boot();
    const agent = await t.start();
    writeFileSync(join(agent.workspace.path, "x.txt"), "x\n");
    git(agent.workspace.path, "add", "x.txt"); git(agent.workspace.path, "commit", "-m", "Add x");
    await t.call("DELETE", `/api/agents/${agent.id}`);
    expect(git(t.repo, "log", "--format=%s", "-1", agent.workspace.branch)).toBe("Add x");
  });
});
