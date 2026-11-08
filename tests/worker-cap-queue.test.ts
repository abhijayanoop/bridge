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
});
