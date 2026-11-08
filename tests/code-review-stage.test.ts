import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startDaemon } from "../src/server/daemon.ts";
import { createFakeAgentRunner } from "../src/server/fake-agent.ts";
import type { GitHub } from "../src/server/github.ts";
import { createClaudeReviewer, parseFindings, type Finding, type ReviewRequest, type ReviewResult, type Reviewer } from "../src/server/reviewer.ts";
import type { CommandRunner } from "../src/server/sbx.ts";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" }).trim();

const finding = (axis: Finding["axis"], severity: Finding["severity"], summary: string, extra: Partial<Finding> = {}): Finding => ({ axis, severity, summary, ...extra });

/** A reviewer the test controls: each review waits for the test to answer it. */
function fakeReviewer() {
  const requests: ReviewRequest[] = [];
  const waiting: ((r: ReviewResult) => void)[] = [];
  const reviewer: Reviewer = {
    review: (req) => { requests.push(req); return new Promise((resolve) => waiting.push(resolve)); },
  };
  return { reviewer, requests, answer: (r: ReviewResult) => waiting.shift()!(r) };
}

async function boot(withReviewer = true, existingDir?: string) {
  const rv = fakeReviewer();
  const opened: { branch: string; title: string }[] = [];
  const github: GitHub = {
    createPullRequest: async (c) => { opened.push(c); return { ok: true, url: `https://github.com/o/r/pull/${opened.length}`, number: opened.length }; },
    pullState: async () => "open",
    mergePullRequest: async () => ({ ok: true }),
  };
  const dir = existingDir ?? mkdtempSync(join(tmpdir(), "bridge-review-"));
  if (!existingDir) cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const repo = join(dir, "repo");
  if (!existingDir) {
    mkdirSync(join(repo, ".scratch", "f", "issues"), { recursive: true });
    writeFileSync(join(repo, ".scratch", "f", "issues", "01-add-thing.md"), "# 01: Add thing\n\n**Status:** ready-for-agent\n\n- [ ] it works\n");
    writeFileSync(join(repo, ".scratch", "f", "issues", "02-other.md"), "# 02: Other\n\n**Status:** ready-for-agent\n");
    writeFileSync(join(repo, "app.txt"), "hello\n");
    git(repo, "init", "-b", "main"); git(repo, "add", "-A"); git(repo, "commit", "-m", "init");
  }
  const daemon = await startDaemon({
    dataDir: join(dir, "data"), runner: createFakeAgentRunner([]), github, pullPollMs: 0,
    reviewer: withReviewer ? rv.reviewer : undefined,
  });
  let closed = false;
  const close = daemon.close.bind(daemon);
  daemon.close = async () => { if (!closed) { closed = true; await close(); } };
  cleanups.push(() => daemon.close());
  const call = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(daemon.url + path, { method, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, json: (await r.json()) as any };
  };
  const project = ((await call("GET", "/api/projects")).json as any[])[0] ?? (await call("POST", "/api/projects", { name: "demo", path: repo })).json;
  const startAgent = async () => (await call("POST", "/api/agents", { projectId: project.id, name: "A", ticket: "f/01" })).json;
  /** The agent reports done through its hook, as when its session ends. */
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
  const reviews = async () => (await call("GET", "/api/reviews")).json as any[];
  const agentStatus = async (agent: any) => (await call("GET", "/api/agents")).json.find((a: any) => a.id === agent.id).status;
  const ticketStatus = () =>
    readFileSync(join(repo, ".scratch", "f", "issues", "01-add-thing.md"), "utf8").split(/\r?\n/).find((l) => l.startsWith("**Status:**"))!.slice("**Status:**".length).trim();
  return { ...rv, daemon, dir, opened, call, startAgent, finish, commit, events, reviews, agentStatus, ticketStatus, repo };
}

describe("code-review stage via the public API", { timeout: 40_000 }, () => {
  it("reviews the branch when the agent finishes, and opens the pull request only after the review passes", async () => {
    const t = await boot();
    const agent = await t.startAgent();
    t.commit(agent);
    await t.finish(agent);
    await expect.poll(() => t.requests.length).toBe(1);
    // The reviewer is given the agent's clone, its branch, the commit it branched from, and the ticket.
    expect(t.requests[0]).toMatchObject({ cwd: agent.workspace.path, branch: agent.workspace.branch, ticketFile: ".scratch/f/issues/01-add-thing.md" });
    expect(t.requests[0]!.base).toBe(git(t.repo, "rev-parse", "main"));
    // While it runs there is a running review and no pull request: the ticket is not ready to merge.
    expect(await t.reviews()).toMatchObject([{ status: "running", ticketKey: "01", round: 1, findings: [] }]);
    expect(t.opened).toEqual([]);
    expect(t.ticketStatus()).toBe("ready-for-agent");

    t.answer({ ok: true, findings: [] });
    await expect.poll(() => t.opened.length).toBe(1);
    expect(t.opened[0]!.branch).toBe(agent.workspace.branch);
    expect(await t.reviews()).toMatchObject([{ status: "passed", findings: [] }]);
    await expect.poll(() => t.ticketStatus()).toBe("in-review");
  });

  it("keeps findings per axis, most severe first, and sends the blocking ones back to the author as work to do", async () => {
    const t = await boot();
    const agent = await t.startAgent();
    t.commit(agent);
    await t.finish(agent);
    await expect.poll(() => t.requests.length).toBe(1);
    t.answer({ ok: true, findings: [
      finding("standards", "low", "Rename r to result", { file: "hello.py", line: 1 }),
      finding("spec", "medium", "Box 2 is only half done"),
      finding("standards", "high", "No test for the new endpoint", { file: "tests/x.test.ts" }),
      finding("spec", "high", "The queue is not persisted"),
    ] });
    await expect.poll(async () => (await t.reviews())[0]?.status).toBe("changes-requested");
    const [review] = await t.reviews();
    expect(review.findings.map((f: any) => [f.axis, f.severity, f.summary])).toEqual([
      ["standards", "high", "No test for the new endpoint"],
      ["spec", "high", "The queue is not persisted"],
      ["spec", "medium", "Box 2 is only half done"],
      ["standards", "low", "Rename r to result"],
    ]);
    // Nothing is ready to merge yet.
    expect(t.opened).toEqual([]);
    // The author is told, in its terminal, what to fix (high and medium; the low note is only shown to the user) and is working again.
    const said = await t.events(agent);
    expect(said).toContain("The queue is not persisted");
    expect(said).toContain("No test for the new endpoint");
    expect(said).toContain("Box 2 is only half done");
    expect(said).not.toContain("Rename r to result");
    expect(await t.agentStatus(agent)).toBe("working");

    // It fixes the work and finishes again: a second round runs, and a clean one opens the pull request.
    t.commit(agent, "fix.py");
    await t.finish(agent);
    await expect.poll(() => t.requests.length).toBe(2);
    t.answer({ ok: true, findings: [finding("standards", "low", "Consider a shorter name")] });
    await expect.poll(() => t.opened.length).toBe(1);
    const rounds = await t.reviews();
    expect(rounds.map((r) => [r.round, r.status])).toEqual([[2, "passed"], [1, "changes-requested"]]);
  });

  it("stops sending work back after two rounds and hands the pull request to the user with the review marked unresolved", async () => {
    const t = await boot();
    const agent = await t.startAgent();
    for (const round of [1, 2]) {
      t.commit(agent, `r${round}.py`);
      await t.finish(agent);
      await expect.poll(() => t.requests.length).toBe(round);
      t.answer({ ok: true, findings: [finding("spec", "high", `Still wrong in round ${round}`)] });
      if (round === 1) await expect.poll(async () => (await t.agentStatus(agent))).toBe("working");
    }
    await expect.poll(() => t.opened.length).toBe(1);
    expect((await t.reviews()).map((r) => [r.round, r.status])).toEqual([[2, "unresolved"], [1, "changes-requested"]]);
    expect(await t.events(agent)).toContain("review found work that is still open");
  });

  it("opens the pull request anyway when the reviewer itself fails, and says so", async () => {
    const t = await boot();
    const agent = await t.startAgent();
    await t.finish(agent);
    await expect.poll(() => t.requests.length).toBe(1);
    t.answer({ ok: false, reason: "claude is not installed" });
    await expect.poll(() => t.opened.length).toBe(1);
    expect(await t.reviews()).toMatchObject([{ status: "failed", reason: "claude is not installed", findings: [] }]);
    expect(await t.events(agent)).toContain("Code review could not run: claude is not installed");
  });

  it("does not review an agent the user stopped", async () => {
    const t = await boot();
    const agent = await t.startAgent();
    await t.call("POST", `/api/agents/${agent.id}/stop`, {});
    expect(t.requests).toEqual([]);
    expect(await t.reviews()).toEqual([]);
  });

  it("an agent the user stops during its review is not sent back to work and gets no pull request", async () => {
    const t = await boot();
    const agent = await t.startAgent();
    await t.finish(agent);
    await expect.poll(() => t.requests.length).toBe(1);
    await t.call("POST", `/api/agents/${agent.id}/stop`, {});
    t.answer({ ok: true, findings: [finding("spec", "high", "Something to fix")] });
    await expect.poll(async () => (await t.reviews())[0]?.status).toBe("failed");
    expect((await t.reviews())[0].reason).toContain("stopped or deleted");
    expect(await t.agentStatus(agent)).toBe("done");
    expect(await t.events(agent)).not.toContain("Something to fix");
    expect(t.opened).toEqual([]);
  });

  it("an agent deleted during its review leaves no pull request and no stray events", async () => {
    const t = await boot();
    const agent = await t.startAgent();
    await t.finish(agent);
    await expect.poll(() => t.requests.length).toBe(1);
    await t.call("DELETE", `/api/agents/${agent.id}`);
    t.answer({ ok: false, reason: "the clone is gone" });
    await expect.poll(async () => (await t.reviews())[0]?.status).toBe("failed");
    expect((await t.call("GET", `/api/agents/${agent.id}/events`)).json).toEqual([]);
    expect(t.opened).toEqual([]);
  });

  it("a review that was running when Bridge stopped is marked failed on the next start, not left reviewing forever", async () => {
    const first = await boot();
    const agent = await first.startAgent();
    await first.finish(agent);
    await expect.poll(() => first.requests.length).toBe(1);
    expect(await first.reviews()).toMatchObject([{ status: "running" }]);
    await first.daemon.close();
    const second = await boot(true, first.dir);
    expect(await second.reviews()).toMatchObject([{ status: "failed", reason: expect.stringContaining("restarted") }]);
  });

  it("an agent under review keeps its worker slot until the review settles", async () => {
    const t = await boot();
    await t.call("POST", "/api/limits", { cap: 1 });
    const agent = await t.startAgent();
    const project = (await t.call("GET", "/api/projects")).json[0];
    expect((await t.call("POST", "/api/agents", { projectId: project.id, name: "B", ticket: "f/02" })).status).toBe(202);
    await t.finish(agent);
    await expect.poll(() => t.requests.length).toBe(1);
    expect((await t.call("GET", "/api/limits")).json).toMatchObject({ running: 1, queued: [{ ticketKey: "02" }] });
    t.answer({ ok: true, findings: [] });
    // Starting the queued ticket clones the repo, which can take a few seconds.
    await expect.poll(async () => (await t.call("GET", "/api/limits")).json.queued.length, { timeout: 20_000 }).toBe(0);
    expect((await t.call("GET", "/api/agents")).json).toHaveLength(2);
  });

  it("without a reviewer the pull request opens straight away", async () => {
    const t = await boot(false);
    const agent = await t.startAgent();
    await t.finish(agent);
    await expect.poll(() => t.opened.length).toBe(1);
    expect(await t.reviews()).toEqual([]);
  });
});

describe("Claude CLI reviewer adapter", () => {
  const req: ReviewRequest = { cwd: "/agent-clone", branch: "ticket/12-x", base: "abc123", ticketFile: ".scratch/f/issues/12-x.md" };
  /** A fake command runner: `git clone` succeeds (unless told otherwise) and `claude` answers with `reply`. */
  const runner = (reply: { code: number; stdout?: string; stderr?: string }, cloneCode = 0) => {
    const calls: { cmd: string; args: string[]; cwd?: string }[] = [];
    const run: CommandRunner = async (cmd, args, opts) => {
      calls.push({ cmd, args, cwd: opts?.cwd });
      if (cmd === "git") return { code: cloneCode, stdout: "", stderr: cloneCode ? "fatal: could not clone" : "" };
      return { code: reply.code, stdout: reply.stdout ?? "", stderr: reply.stderr ?? "" };
    };
    return { reviewer: createClaudeReviewer(run), calls };
  };

  it("reviews a clean checkout of the branch, not the agent's clone, headless with read-only tools and the user's own settings only", async () => {
    const reply = JSON.stringify({ findings: [{ axis: "spec", severity: "high", summary: "Box 3 is missing", file: "a.ts", line: 4 }, { axis: "standards", severity: "low", summary: "Rename x" }] });
    const t = runner({ code: 0, stdout: reply });
    expect(await t.reviewer.review(req)).toEqual({ ok: true, findings: [
      { axis: "spec", severity: "high", summary: "Box 3 is missing", file: "a.ts", line: 4 },
      { axis: "standards", severity: "low", summary: "Rename x" },
    ] });
    const [clone, claude] = t.calls;
    // The agent controls its clone's git config, hooks and settings, so none of it is used: the branch is cloned afresh.
    expect(clone!.cmd).toBe("git");
    expect(clone!.args.slice(0, 5)).toEqual(["clone", "--quiet", "--no-hardlinks", "--branch", "ticket/12-x"]);
    expect(clone!.args).toContain("/agent-clone");
    const checkout = clone!.args.at(-1)!;
    expect(checkout).not.toBe("/agent-clone");
    expect(claude).toMatchObject({ cmd: "claude", cwd: checkout });
    expect(claude!.args[0]).toBe("-p");
    expect(claude!.args[1]).toContain("code-review");
    expect(claude!.args[1]).toContain("abc123");
    expect(claude!.args[1]).toContain(".scratch/f/issues/12-x.md");
    // Project and local settings (which the branch could carry) are ignored; changing tools are denied outright.
    expect(claude!.args[claude!.args.indexOf("--setting-sources") + 1]).toBe("user");
    const disallowed = claude!.args[claude!.args.indexOf("--disallowedTools") + 1]!;
    for (const tool of ["Edit", "Write", "NotebookEdit"]) expect(disallowed).toContain(tool);
    const allowed = claude!.args.slice(claude!.args.indexOf("--allowedTools") + 1, claude!.args.indexOf("--disallowedTools"));
    expect(allowed).toContain("Read");
    expect(allowed.join(" ")).not.toMatch(/Edit|Write|git (commit|push|merge|checkout)|Bash\(\*\)|Bash$/);
    expect(claude!.args).not.toContain("--dangerously-skip-permissions");
  });

  it("reports a clone that fails, without running the review", async () => {
    const t = runner({ code: 0, stdout: "{}" }, 128);
    expect(await t.reviewer.review(req)).toEqual({ ok: false, reason: "could not check out the branch to review: fatal: could not clone" });
    expect(t.calls.some((c) => c.cmd === "claude")).toBe(false);
  });

  it("finds the JSON in a fenced block or a sentence, and rejects a reply with any malformed finding rather than dropping it", async () => {
    const good = { axis: "spec", severity: "medium", summary: "Half done" };
    const fenced = "Here is the review:\n```json\n" + JSON.stringify({ findings: [good] }) + "\n```\nDone.";
    expect(parseFindings(fenced)).toEqual([good]);
    expect(parseFindings('The result is {"findings": []} as asked.')).toEqual([]);
    expect(parseFindings("Looks fine to me!")).toBeNull();
    // A finding with an unknown axis or severity, or no summary, could hide a real problem: the whole reply is refused.
    for (const bad of [{ axis: "style", severity: "high", summary: "x" }, { axis: "spec", severity: "urgent", summary: "x" }, { axis: "spec", severity: "high", summary: "" }]) {
      expect(parseFindings(JSON.stringify({ findings: [good, bad] }))).toBeNull();
    }
    expect(await runner({ code: 0, stdout: "Looks fine to me!" }).reviewer.review(req)).toMatchObject({ ok: false, reason: expect.stringContaining("expected JSON") });
  });

  it("reports a failed CLI run with its last error line", async () => {
    const r = await runner({ code: 1, stderr: "warming up\nError: not logged in\n" }).reviewer.review(req);
    expect(r).toEqual({ ok: false, reason: "the claude CLI exited with 1: Error: not logged in" });
  });
});
