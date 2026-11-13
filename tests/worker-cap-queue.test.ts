import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startDaemon } from "../src/server/daemon.ts";
import { createFakeAgentRunner } from "../src/server/fake-agent.ts";
import type { AgentEvent, AgentRunner, AgentSpec } from "../src/server/agent-runner.ts";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

const ticketFile = (n: string, status = "ready-for-agent", blockedBy = "") =>
  `# ${n}: Ticket ${n}\n\n**Blocked by:** ${blockedBy}\n\n**Status:** ${status}\n`;

async function boot(opts: { tickets?: Record<string, string>; dir?: string } = {}) {
  const dir = opts.dir ?? mkdtempSync(join(tmpdir(), "bridge-cap-"));
  if (!opts.dir) cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const repo = join(dir, "repo");
  mkdirSync(join(repo, ".scratch", "f", "issues"), { recursive: true });
  const tickets = opts.tickets ?? { "01-a": ticketFile("01"), "02-b": ticketFile("02"), "03-c": ticketFile("03") };
  for (const [name, text] of Object.entries(tickets)) writeFileSync(join(repo, ".scratch", "f", "issues", `${name}.md`), text);
  const specs: AgentSpec[] = [];
  const emitters = new Map<string, (e: AgentEvent) => void>();
  const fake = createFakeAgentRunner([]);
  const runner: AgentRunner = { ...fake, start(spec, emit) { specs.push(spec); emitters.set(spec.id, emit); fake.start(spec, emit); } };
  const daemon = await startDaemon({ dataDir: join(dir, "data"), runner });
  let closed = false;
  const close = daemon.close.bind(daemon);
  daemon.close = async () => { if (!closed) { closed = true; await close(); } };
  cleanups.push(() => daemon.close());
  const call = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(daemon.url + path, { method, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, json: (await r.json()) as any };
  };
  const post = (path: string, body: unknown) => call("POST", path, body);
  const existing = (await call("GET", "/api/projects")).json as any[];
  const project = existing[0] ?? (await post("/api/projects", { name: "demo", path: repo })).json;
  const start = (ticket?: string, extra: object = {}) => post("/api/agents", { projectId: project.id, name: `W${ticket ?? ""}`, ticket, ...extra });
  const limits = async () => (await call("GET", "/api/limits")).json;
  const finish = (agentId: string) => post(`/api/agents/${agentId}/stop`, {});
  return { daemon, dir, repo, project, specs, emitters, start, limits, finish, post, call };
}

describe("worker cap and queue via the public API", () => {
  it("runs at most 2 workers at once; a third ticket waits in the queue", async () => {
    const { start, specs, limits } = await boot();
    expect((await start("f/01")).status).toBe(201);
    expect((await start("f/02")).status).toBe(201);
    const third = await start("f/03");
    expect(third.status).toBe(202);
    expect(third.json.queued).toBe(true);
    expect(specs).toHaveLength(2);
    const l = await limits();
    expect(l).toMatchObject({ cap: 2, max: 3, running: 2 });
    expect(l.queued.map((q: any) => q.ticketKey)).toEqual(["03"]);
  });

  it("starts the oldest queued ticket when a running worker finishes", async () => {
    const { start, specs, limits, finish } = await boot();
    const a = (await start("f/01")).json;
    await start("f/02");
    await start("f/03");
    expect(specs).toHaveLength(2);
    await finish(a.id);
    await expect.poll(() => specs.length).toBe(3);
    expect(specs[2]!.task).toContain("ticket 03");
    const l = await limits();
    expect(l.running).toBe(2);
    expect(l.queued).toEqual([]);
  });

  it("a worker that reports done frees its slot", async () => {
    const { start, specs, emitters } = await boot();
    const a = (await start("f/01")).json;
    await start("f/02");
    await start("f/03");
    emitters.get(a.id)!({ type: "status", status: "done" });
    await expect.poll(() => specs.length).toBe(3);
  });

  it("the cap can be raised to 3 and no higher; raising it starts waiting tickets", async () => {
    const { start, specs, limits, post } = await boot();
    await start("f/01"); await start("f/02"); await start("f/03");
    expect((await post("/api/limits", { cap: 4 })).status).toBe(400);
    expect((await post("/api/limits", { cap: 0 })).status).toBe(400);
    expect((await post("/api/limits", { cap: "3" })).status).toBe(400);
    expect(specs).toHaveLength(2);
    const r = await post("/api/limits", { cap: 3 });
    expect(r.status).toBe(200);
    expect(r.json.cap).toBe(3);
    expect(specs).toHaveLength(3);
    expect((await limits()).queued).toEqual([]);
  });

  it("keeps the configured cap after a restart", async () => {
    const first = await boot();
    await first.post("/api/limits", { cap: 3 });
    await first.daemon.close();
    const second = await boot({ dir: first.dir });
    expect((await second.limits()).cap).toBe(3);
  });

  it("a queued ticket waits for its blockers; a later ticket can go first", async () => {
    const tickets = {
      "01-a": ticketFile("01"), "02-b": ticketFile("02"),
      "03-c": ticketFile("03", "ready-for-agent", "01"),
      "04-d": ticketFile("04"),
    };
    const { start, specs, limits, finish, post, project } = await boot({ tickets });
    const a = (await start("f/01")).json;
    const b = (await start("f/02")).json;
    expect((await start("f/03")).status).toBe(202);
    expect((await start("f/04")).status).toBe(202);
    await finish(b.id);
    // 03 is first in line but blocked by 01, which is still running, so 04 takes the slot.
    await expect.poll(() => specs.length).toBe(3);
    expect(specs[2]!.task).toContain("ticket 04");
    expect((await limits()).queued.map((q: any) => [q.ticketKey, q.blocked])).toEqual([["03", true]]);
    // Finishing 01's agent is not enough: the blocker is done only when its ticket is.
    await finish(a.id);
    expect(specs).toHaveLength(3);
    await post(`/api/projects/${project.id}/tickets/status`, { ticket: "f/01", column: "done" });
    await expect.poll(() => specs.length).toBe(4);
    expect(specs[3]!.task).toContain("ticket 03");
  });

  it("a blocked ticket queues even when a slot is free", async () => {
    const tickets = { "01-a": ticketFile("01"), "02-b": ticketFile("02", "ready-for-agent", "01") };
    const { start, specs, limits } = await boot({ tickets });
    const r = await start("f/02");
    expect(r.status).toBe(202);
    expect(specs).toHaveLength(0);
    expect((await limits()).queued[0].blocked).toBe(true);
  });

  it("a detected rate limit pauses the queue until the user resumes it", async () => {
    const { start, specs, limits, finish, emitters, post } = await boot();
    const a = (await start("f/01")).json;
    await start("f/02");
    await start("f/03");
    emitters.get(a.id)!({ type: "output", data: "[31mClaude usage limit reached.[0m Your limit will reset at 3pm" });
    await expect.poll(async () => (await limits()).rateLimited).toMatchObject({ agentId: a.id });
    await finish(a.id);
    // A slot is free but the queue is paused, and new tickets queue too.
    expect((await start("f/03")).status).toBe(202);
    expect(specs).toHaveLength(2);
    const r = await post("/api/limits/resume", {});
    expect(r.json.rateLimited).toBeNull();
    expect(specs).toHaveLength(3);
  });

  it("ordinary output that mentions rate limits does not pause the queue", async () => {
    const { start, limits, emitters } = await boot();
    const a = (await start("f/01")).json;
    emitters.get(a.id)!({ type: "output", data: "I will add a rate limiter and handle the rate limit header" });
    emitters.get(a.id)!({ type: "output", data: "done" });
    expect((await limits()).rateLimited).toBeNull();
  });

  it("broadcasts limits changes over the websocket", async () => {
    const { daemon, start } = await boot();
    const ws = new WebSocket(daemon.url.replace("http", "ws") + "/ws");
    const got: any[] = [];
    await new Promise((r) => ws.addEventListener("open", r, { once: true }));
    ws.addEventListener("message", (m) => got.push(JSON.parse(String(m.data))));
    cleanups.push(() => ws.close());
    await start("f/01"); await start("f/02"); await start("f/03");
    await expect.poll(() => got.some((m) => m.type === "limits" && m.limits.queued.length === 1)).toBe(true);
  });

  it("the lead and agents without a ticket do not use worker slots", async () => {
    const { start, limits } = await boot();
    await start("f/01"); await start("f/02");
    expect((await start(undefined, { lead: true })).status).toBe(201);
    expect((await start(undefined)).status).toBe(201);
    expect((await limits()).running).toBe(2);
  });

  it("a queued ticket whose clone fails stays in the queue with the error, and Resume retries it", async () => {
    const { repo, dir, start, specs, limits, finish, post } = await boot();
    const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: repo });
    git("init", "-b", "main"); git("add", "-A"); git("commit", "-m", "init");
    const a = (await start("f/01")).json;
    await start("f/02");
    await start("f/03");
    // Make the next clone fail: the clones directory is replaced by a plain file.
    rmSync(join(dir, "data", "clones"), { recursive: true, force: true });
    writeFileSync(join(dir, "data", "clones"), "in the way");
    await finish(a.id);
    await expect.poll(async () => (await limits()).queued[0]?.error).toMatch(/clone/);
    expect(specs).toHaveLength(2);
    // Not retried on every change, but retried when the user resumes.
    rmSync(join(dir, "data", "clones"), { force: true });
    expect(specs).toHaveLength(2);
    await post("/api/limits/resume", {});
    expect(specs).toHaveLength(3);
    expect((await limits()).queued).toEqual([]);
  });
});

describe("auto-dispatch via the public API", () => {
  it("defaults to off and round-trips through the API", async () => {
    const { project, call, post } = await boot();
    expect((await call("GET", `/api/projects/${project.id}/auto-dispatch`)).json).toEqual({ on: false });
    const set = await post(`/api/projects/${project.id}/auto-dispatch`, { on: true });
    expect(set.json).toEqual({ on: true });
    expect((await call("GET", `/api/projects/${project.id}/auto-dispatch`)).json).toEqual({ on: true });
  });

  it("starts every ready, unblocked ticket on its own, with no call to the manual start endpoint; the rest queue at the cap", async () => {
    const { project, post, specs, limits } = await boot(); // tickets 01, 02, 03 all ready-for-agent, unblocked
    await post(`/api/projects/${project.id}/auto-dispatch`, { on: true });
    await expect.poll(() => specs.length).toBe(2);
    expect(specs.map((s) => s.task)).toEqual([expect.stringContaining("ticket 01"), expect.stringContaining("ticket 02")]);
    const l = await limits();
    expect(l.running).toBe(2);
    expect(l.queued.map((q: any) => q.ticketKey)).toEqual(["03"]);
  });

  it("never double-starts a ticket that is already running or already queued", async () => {
    const { project, post, start, specs, limits } = await boot({ tickets: { "01-a": ticketFile("01"), "02-b": ticketFile("02") } });
    await post("/api/limits", { cap: 1 });
    const a = (await start("f/01")).json; // already running by hand
    expect((await start("f/02")).status).toBe(202); // already queued by hand
    expect(specs).toHaveLength(1);
    await post(`/api/projects/${project.id}/auto-dispatch`, { on: true });
    // Neither ticket gets a second entry: 01 stays the sole running worker, 02 the sole queued one.
    expect(specs.filter((s) => s.task?.includes("ticket 01"))).toHaveLength(1);
    expect((await limits()).queued.filter((q: any) => q.ticketKey === "02")).toHaveLength(1);
    await post(`/api/agents/${a.id}/stop`, {});
    await expect.poll(() => specs.length).toBe(2);
    expect(specs.filter((s) => s.task?.includes("ticket 02"))).toHaveLength(1);
  });

  it("pauses auto-dispatch while the plan's rate limit is active, and resumes once it lifts", async () => {
    const { project, post, specs, emitters, limits } = await boot(); // tickets 01, 02, 03
    await post(`/api/projects/${project.id}/auto-dispatch`, { on: true });
    await expect.poll(() => specs.length).toBe(2);
    const a = specs[0]!;
    emitters.get(a.id)!({ type: "output", data: "Claude usage limit reached. Your limit will reset at 3pm" });
    await expect.poll(async () => (await limits()).rateLimited).toMatchObject({ agentId: a.id });
    // Ticket 01 is done and its worker's slot frees, but the pause still holds: 03 is not auto-started.
    await post(`/api/projects/${project.id}/tickets/status`, { ticket: "f/01", column: "done" });
    await post(`/api/agents/${a.id}/stop`, {});
    expect(specs).toHaveLength(2);
    expect((await limits()).queued.map((q: any) => q.ticketKey)).toEqual(["03"]);
    await post("/api/limits/resume", {});
    await expect.poll(() => specs.length).toBe(3);
    expect(specs[2]!.task).toContain("ticket 03");
  });

  it("leaves a ticket whose auto-start attempt fails for a human, without retrying it automatically", async () => {
    const { dir, repo, project, post, specs, limits } = await boot({ tickets: { "01-a": ticketFile("01") } });
    const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: repo });
    git("init", "-b", "main"); git("add", "-A"); git("commit", "-m", "init");
    // Make every clone fail: the clones directory is replaced by a plain file.
    rmSync(join(dir, "data", "clones"), { recursive: true, force: true });
    writeFileSync(join(dir, "data", "clones"), "in the way");
    await post(`/api/projects/${project.id}/auto-dispatch`, { on: true });
    await expect.poll(async () => (await limits()).queued[0]?.error).toMatch(/clone/);
    expect(specs).toHaveLength(0);
    // Re-evaluating readiness again (a cap change re-triggers drain) does not retry it.
    await post("/api/limits", { cap: 2 });
    expect(specs).toHaveLength(0);
    expect((await limits()).queued).toHaveLength(1);
  });

  it("auto-starts a dependent the moment its blocker is merged, with no other trigger", async () => {
    const tickets = { "01-a": ticketFile("01"), "02-b": ticketFile("02", "ready-for-agent", "01") };
    const { project, post, specs } = await boot({ tickets });
    await post(`/api/projects/${project.id}/auto-dispatch`, { on: true });
    await expect.poll(() => specs.length).toBe(1);
    expect(specs[0]!.task).toContain("ticket 01");
    await post(`/api/projects/${project.id}/tickets/status`, { ticket: "f/01", column: "done" });
    await expect.poll(() => specs.length).toBe(2);
    expect(specs[1]!.task).toContain("ticket 02");
  });

  it("does not let a ticket running in one project block the same-named ticket in another project", async () => {
    const { dir, post, start, specs, project: projectA } = await boot({ tickets: { "01-a": ticketFile("01") } });
    await start("f/01"); // running in project A
    expect(specs).toHaveLength(1);

    const repoB = join(dir, "repoB");
    mkdirSync(join(repoB, ".scratch", "f", "issues"), { recursive: true });
    writeFileSync(join(repoB, ".scratch", "f", "issues", "01-a.md"), ticketFile("01")); // same feature/ticket id as A's
    const projectB = (await post("/api/projects", { name: "demoB", path: repoB })).json;
    expect(projectB.id).not.toBe(projectA.id);

    await post(`/api/projects/${projectB.id}/auto-dispatch`, { on: true });
    await expect.poll(() => specs.length).toBe(2);
    expect(specs[1]!.projectId).toBe(projectB.id);
  });

  it("turning auto-dispatch off stops further automatic starts; the ticket can still be started manually", async () => {
    const tickets = { "01-a": ticketFile("01"), "02-b": ticketFile("02", "ready-for-agent", "01") };
    const { project, post, start, specs } = await boot({ tickets });
    await post(`/api/projects/${project.id}/auto-dispatch`, { on: true });
    await expect.poll(() => specs.length).toBe(1); // only 01: 02 is still blocked
    await post(`/api/projects/${project.id}/auto-dispatch`, { on: false });
    await post(`/api/projects/${project.id}/tickets/status`, { ticket: "f/01", column: "done" }); // unblocks 02
    expect(specs).toHaveLength(1); // not auto-started: the dispatcher is off
    expect((await start("f/02")).status).toBe(201); // manual start still works
    expect(specs).toHaveLength(2);
  });
});

describe("auto-dispatch toggle and provenance", () => {
  const terminalText = async (call: (m: string, p: string) => Promise<{ json: any }>, agentId: string) =>
    ((await call("GET", `/api/agents/${agentId}/events`)).json as { event: { type: string; data?: string } }[])
      .filter((e) => e.event.type === "output").map((e) => e.event.data).join("");

  it("keeps each project's own toggle state, independent of the others", async () => {
    const { dir, project: a, call, post } = await boot();
    const repoB = join(dir, "repoB");
    mkdirSync(join(repoB, ".scratch", "f", "issues"), { recursive: true });
    const b = (await post("/api/projects", { name: "demoB", path: repoB })).json;
    await post(`/api/projects/${a.id}/auto-dispatch`, { on: true });
    expect((await call("GET", `/api/projects/${a.id}/auto-dispatch`)).json).toEqual({ on: true });
    expect((await call("GET", `/api/projects/${b.id}/auto-dispatch`)).json).toEqual({ on: false });
    await post(`/api/projects/${a.id}/auto-dispatch`, { on: false });
    await post(`/api/projects/${b.id}/auto-dispatch`, { on: true });
    expect((await call("GET", `/api/projects/${a.id}/auto-dispatch`)).json).toEqual({ on: false });
    expect((await call("GET", `/api/projects/${b.id}/auto-dispatch`)).json).toEqual({ on: true });
  });

  it("marks an auto-started agent, on its row and in its terminal, but not a manual one", async () => {
    const { project, call, post, start, specs } = await boot({ tickets: { "01-a": ticketFile("01"), "02-b": ticketFile("02", "in-progress") } });
    const manual = (await start("f/02")).json;
    await post(`/api/projects/${project.id}/auto-dispatch`, { on: true });
    await expect.poll(() => specs.length).toBe(2);
    const agents = (await call("GET", "/api/agents")).json as any[];
    const auto = agents.find((x) => x.ticketKey === "01")!;
    expect(auto.autoStarted).toBe(true);
    expect(agents.find((x) => x.id === manual.id)!.autoStarted).toBe(false);
    expect(await terminalText(call, auto.id)).toContain("Started automatically by auto-dispatch");
    expect(await terminalText(call, manual.id)).not.toContain("Started automatically");
  });

  it("does not mark a ticket the user queued by hand when it later starts from the queue", async () => {
    const { project, call, post, start, specs } = await boot({ tickets: { "01-a": ticketFile("01"), "02-b": ticketFile("02"), "03-c": ticketFile("03") } });
    await start("f/01"); await start("f/02");
    expect((await start("f/03")).status).toBe(202); // queued by hand
    await post(`/api/projects/${project.id}/auto-dispatch`, { on: true });
    const first = (await call("GET", "/api/agents")).json[0];
    await post(`/api/agents/${first.id}/stop`, {});
    await expect.poll(() => specs.length).toBe(3);
    const third = ((await call("GET", "/api/agents")).json as any[]).find((x) => x.ticketKey === "03")!;
    expect(third.autoStarted).toBe(false);
  });
});
