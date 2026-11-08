import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startDaemon } from "../src/server/daemon.ts";
import { createFakeAgentRunner } from "../src/server/fake-agent.ts";
import { createGitHubCli, type GitHub, type PullResult } from "../src/server/github.ts";
import type { CommandRunner } from "../src/server/sbx.ts";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" }).trim();

interface Call { repoPath: string; branch: string; title: string; body: string }

async function boot(result?: (c: Call) => PullResult) {
  const calls: Call[] = [];
  const github: GitHub = {
    createPullRequest: async (c) => {
      calls.push(c);
      return result ? result(c) : { ok: true, url: `https://github.com/o/r/pull/${calls.length}`, number: calls.length };
    },
  };
  const dir = mkdtempSync(join(tmpdir(), "bridge-pr-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const repo = join(dir, "repo");
  mkdirSync(join(repo, ".scratch", "f", "issues"), { recursive: true });
  writeFileSync(join(repo, ".scratch", "f", "issues", "01-add-thing.md"), "# 01: Add thing\n\n**Status:** ready-for-agent\n\n- [ ] it works\n");
  writeFileSync(join(repo, "app.txt"), "hello\n");
  git(repo, "init", "-b", "main"); git(repo, "add", "-A"); git(repo, "commit", "-m", "init");
  const daemon = await startDaemon({ dataDir: join(dir, "data"), runner: createFakeAgentRunner([]), github });
  cleanups.push(() => daemon.close());
  const call = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(daemon.url + path, { method, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, json: (await r.json()) as any };
  };
  const project = (await call("POST", "/api/projects", { name: "demo", path: repo })).json;
  const startAgent = async () => (await call("POST", "/api/agents", { projectId: project.id, name: "A", ticket: "f/01" })).json;
  /** The agent reports done through its hook, as when its session ends. The hook script carries the agent's token. */
  const finish = (agent: any) => {
    const script = readFileSync(join(agent.workspace.path, ".claude", "bridge-hook.mjs"), "utf8");
    const token = script.match(/"x-bridge-token": "([0-9a-f-]+)"/)![1]!;
    return fetch(`${daemon.url}/api/agents/${agent.id}/hook`, { method: "POST", headers: { "x-bridge-token": token }, body: JSON.stringify({ status: "done" }) });
  };
  const commit = (agent: any, file = "hello.py") => {
    writeFileSync(join(agent.workspace.path, file), "print('hi')\n");
    git(agent.workspace.path, "add", file);
    git(agent.workspace.path, "commit", "-m", `Add ${file}`);
  };
  const events = async (agent: any) => JSON.stringify((await call("GET", `/api/agents/${agent.id}/events`)).json);
  return { call, startAgent, finish, commit, events, calls, repo };
}

describe("pull requests", { timeout: 40_000 }, () => {
  it("opens one pull request titled with the ticket ID when the agent finishes, and lists it", async () => {
    const t = await boot();
    const agent = await t.startAgent();
    t.commit(agent);
    await t.finish(agent);
    await expect.poll(() => t.calls.length).toBe(1);
    expect(t.calls[0]).toMatchObject({ repoPath: t.repo, branch: agent.workspace.branch, title: "01: Add thing" });
    expect(t.calls[0]!.body).toContain("- [ ] it works");
    expect(t.calls[0]!.body).toMatch(/the user merges/);
    await expect.poll(async () => (await t.call("GET", "/api/pulls")).json.length).toBe(1);
    const [pull] = (await t.call("GET", "/api/pulls")).json;
    expect(pull).toMatchObject({ agentId: agent.id, ticketKey: "01", title: "01: Add thing", branch: agent.workspace.branch, url: "https://github.com/o/r/pull/1", state: "open" });
    expect(await t.events(agent)).toContain("Pull request #1 opened: https://github.com/o/r/pull/1");
    // Finishing again does not open a second one.
    await t.finish(agent);
    await new Promise((r) => setTimeout(r, 200));
    expect(t.calls).toHaveLength(1);
  });

  it("keeps the pull request after the agent is deleted", async () => {
    const t = await boot();
    const agent = await t.startAgent();
    await t.finish(agent);
    await expect.poll(async () => (await t.call("GET", "/api/pulls")).json.length).toBe(1);
    await t.call("DELETE", `/api/agents/${agent.id}`);
    expect((await t.call("GET", "/api/pulls")).json).toHaveLength(1);
  });

  it("opens none when the user stops or deletes the agent", async () => {
    const t = await boot();
    const stopped = await t.startAgent();
    t.commit(stopped);
    await t.call("POST", `/api/agents/${stopped.id}/stop`, {});
    const deleted = await t.startAgent();
    await t.call("DELETE", `/api/agents/${deleted.id}`);
    await new Promise((r) => setTimeout(r, 300));
    expect(t.calls).toHaveLength(0);
    expect((await t.call("GET", "/api/pulls")).json).toEqual([]);
  });

  it("reports a failure in the agent's terminal and lists nothing; a repo with no remote is a quiet skip", async () => {
    const failing = await boot(() => ({ ok: false, reason: "git push failed: denied" }));
    const a = await failing.startAgent();
    await failing.finish(a);
    await expect.poll(() => failing.events(a)).toContain("Could not open a pull request: git push failed: denied");
    expect((await failing.call("GET", "/api/pulls")).json).toEqual([]);

    const local = await boot(() => ({ ok: false, skipped: true, reason: "this repo has no GitHub remote, so no pull request was opened" }));
    const b = await local.startAgent();
    await local.finish(b);
    await expect.poll(() => local.events(b)).toContain("no GitHub remote");
    expect(await local.events(b)).not.toContain("Could not open");
  });

  it("a second run of the same ticket does not clobber the first run's branch: it gets its own", async () => {
    const t = await boot();
    const first = await t.startAgent();
    t.commit(first, "one.py");
    await t.call("POST", `/api/agents/${first.id}/stop`, {});
    const second = await t.startAgent();
    t.commit(second, "two.py");
    await t.finish(second);
    await expect.poll(() => t.calls.length).toBe(1);
    expect(t.calls[0]!.branch).toBe(`${first.workspace.branch}-${second.id.slice(0, 8)}`);
    expect(git(t.repo, "log", "--format=%s", "-1", first.workspace.branch)).toBe("Add one.py");
    expect(git(t.repo, "log", "--format=%s", "-1", t.calls[0]!.branch)).toBe("Add two.py");
  });
});

describe("GitHub CLI adapter", () => {
  function fakeCli(reply: (cmd: string, args: string[]) => { code: number; stdout?: string; stderr?: string }) {
    const calls: { cmd: string; args: string[]; cwd?: string }[] = [];
    const run: CommandRunner = async (cmd, args, opts) => {
      calls.push({ cmd, args, cwd: opts?.cwd });
      const r = reply(cmd, args);
      return { code: r.code, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
    };
    return { gh: createGitHubCli(run, "gh"), calls };
  }
  const input = { repoPath: "/repo", branch: "ticket/20-x", title: "20: X", body: "body" };
  const happy = (cmd: string, args: string[]) => {
    if (cmd === "git" && args[0] === "remote") return { code: 0, stdout: "https://github.com/o/r.git" };
    if (args[0] === "repo") return { code: 0, stdout: "main\n" };
    if (args[0] === "pr" && args[1] === "view") return { code: 1, stderr: "no pull requests found" };
    if (args[0] === "push") return { code: 0 };
    if (args[0] === "pr" && args[1] === "create") return { code: 0, stdout: "https://github.com/o/r/pull/7\n" };
    return { code: 1 };
  };

  it("pushes only the ticket branch, then opens the pull request against the default branch", async () => {
    const t = fakeCli(happy);
    expect(await t.gh.createPullRequest(input)).toEqual({ ok: true, url: "https://github.com/o/r/pull/7", number: 7 });
    const push = t.calls.find((c) => c.args[0] === "push")!;
    expect(push.args).toEqual(["push", "origin", "refs/heads/ticket/20-x:refs/heads/ticket/20-x"]);
    expect(push.args.join(" ")).not.toMatch(/--force|-f\b|\+/);
    expect(t.calls.find((c) => c.args[1] === "create")!.args).toEqual(["pr", "create", "--head", "ticket/20-x", "--base", "main", "--title", "20: X", "--body", "body"]);
    expect(t.calls.every((c) => c.cwd === "/repo")).toBe(true);
    expect(t.calls.some((c) => c.args.includes("merge"))).toBe(false);
  });

  it("reuses an existing pull request without pushing again", async () => {
    const t = fakeCli((cmd, args) => (args[0] === "pr" && args[1] === "view" ? { code: 0, stdout: JSON.stringify({ url: "https://github.com/o/r/pull/3", number: 3 }) } : happy(cmd, args)));
    expect(await t.gh.createPullRequest(input)).toEqual({ ok: true, url: "https://github.com/o/r/pull/3", number: 3, existing: true });
    expect(t.calls.some((c) => c.args[0] === "push")).toBe(false);
  });

  it("skips a repo without a remote, refuses the default branch, and reports a failed push", async () => {
    expect(await fakeCli((c, a) => (a[0] === "remote" ? { code: 2 } : happy(c, a))).gh.createPullRequest(input)).toMatchObject({ ok: false, skipped: true });
    const main = fakeCli(happy);
    expect(await main.gh.createPullRequest({ ...input, branch: "main" })).toMatchObject({ ok: false });
    expect(main.calls.some((c) => c.args[0] === "push")).toBe(false);
    const denied = fakeCli((c, a) => (a[0] === "push" ? { code: 1, stderr: "remote: Permission denied\n" } : happy(c, a)));
    expect(await denied.gh.createPullRequest(input)).toEqual({ ok: false, reason: "git push failed: remote: Permission denied" });
    expect(denied.calls.some((c) => c.args[1] === "create")).toBe(false);
  });
});
