import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it } from "vitest";
import { startDaemon } from "../src/server/daemon.ts";
import { createFakeAgentRunner } from "../src/server/fake-agent.ts";
import type { AgentEvent, AgentRunner, AgentSpec } from "../src/server/agent-runner.ts";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

const ticketFile = (n: string) => `# ${n}: Ticket ${n}\n\n**Blocked by:**\n\n**Status:** ready-for-agent\n`;

/** A repo with tickets 01..03 plus a data directory that outlives one daemon. */
function world(git = false) {
  const dir = mkdtempSync(join(tmpdir(), "bridge-resume-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const repo = join(dir, "repo");
  mkdirSync(join(repo, ".scratch", "f", "issues"), { recursive: true });
  for (const n of ["01", "02", "03"]) writeFileSync(join(repo, ".scratch", "f", "issues", `${n}-t.md`), ticketFile(n));
  if (git) {
    const g = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: repo, stdio: "ignore" });
    g("init", "-q"); g("add", "-A"); g("commit", "-q", "-m", "init");
  }
  return { dir, repo, dataDir: join(dir, "data") };
}

/** One daemon "launch" on a data directory. Several can run in turn on the same one. */
async function launch(w: { dataDir: string; repo: string }, o: { stopThrows?: boolean; onQuit?: () => void } = {}) {
  const specs: AgentSpec[] = [];
  const stops: string[] = [];
  const emitters = new Map<string, (e: AgentEvent) => void>();
  const fake = createFakeAgentRunner([]);
  const runner: AgentRunner = {
    ...fake,
    start(spec, emit) { specs.push(spec); emitters.set(spec.id, emit); fake.start(spec, emit); },
    stop(id) { stops.push(id); if (o.stopThrows) throw new Error("taskkill: Access is denied"); fake.stop(id); },
  };
  const daemon = await startDaemon({ dataDir: w.dataDir, runner, onQuit: o.onQuit });
  let closed = false;
  const close = daemon.close.bind(daemon);
  daemon.close = async () => { if (closed) return; closed = true; await close(); };
  cleanups.push(() => daemon.close());
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const r = await fetch(daemon.url + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, json: (await r.json()) as any };
  };
  const projects = (await call("GET", "/api/projects")).json as any[];
  const project = projects[0] ?? (await call("POST", "/api/projects", { name: "demo", path: w.repo })).json;
  const start = (ticket?: string) => call("POST", "/api/agents", { projectId: project.id, name: `W${ticket ?? ""}`, ticket });
  const working = (id: string) => emitters.get(id)?.({ type: "status", status: "working" });
  return { daemon, call, project, start, specs, stops, emitters, working };
}

describe("quit warning via the public API", () => {
  it("warns about running agents and quits only once confirmed", async () => {
    let quits = 0;
    const l = await launch(world(), { onQuit: () => { quits++; } });
    const a = (await l.start("f/01")).json;
    l.working(a.id);
    await expect.poll(async () => (await l.call("GET", "/api/quit-check")).json.running.length).toBe(1);
    const check = (await l.call("GET", "/api/quit-check")).json;
    expect(check.running[0]).toMatchObject({ id: a.id, ticketKey: "01" });
    expect(check.warning).toMatch(/1 agent/);

    const ui = { "x-bridge-ui": "1" };
    expect((await l.call("POST", "/api/quit", {})).status).toBe(403);
    const refused = await l.call("POST", "/api/quit", {}, ui);
    expect(refused.status).toBe(409);
    expect(refused.json.warning).toMatch(/1 agent/);
    expect(quits).toBe(0);

    expect((await l.call("POST", "/api/quit", { confirmed: true }, ui)).status).toBe(200);
    await expect.poll(() => quits).toBe(1);
  });

  it("quits at once when nothing is running", async () => {
    let quits = 0;
    const l = await launch(world(), { onQuit: () => { quits++; } });
    expect((await l.call("GET", "/api/quit-check")).json.warning).toBeNull();
    expect((await l.call("POST", "/api/quit", {}, { "x-bridge-ui": "1" })).status).toBe(200);
    await expect.poll(() => quits).toBe(1);
  });
});

describe("restart and resume via the public API", () => {
  it("stops running agents on exit and resumes them, with the same id, on the next launch", async () => {
    const w = world();
    const first = await launch(w);
    const a = (await first.start("f/01")).json;
    first.working(a.id);
    await expect.poll(async () => (await first.call("GET", "/api/agents")).json[0].status).toBe("working");
    await first.daemon.close();
    const exit = first.daemon.exit!;
    expect(first.stops).toContain(a.id);
    expect(exit.stopped.map((s) => s.id)).toEqual([a.id]);

    const second = await launch(w);
    expect(second.specs).toHaveLength(1);
    expect(second.specs[0]!.id).toBe(a.id);
    expect(second.specs[0]!.task).toContain("ticket 01");
    expect(second.specs[0]!.task).toMatch(/interrupted|restart/i);
    const agents = (await second.call("GET", "/api/agents")).json;
    expect(agents).toHaveLength(1);
    expect(agents[0]).toMatchObject({ id: a.id, status: "working", ticketKey: "01" });
    const report = (await second.call("GET", "/api/restart")).json;
    expect(report.resumed.map((r: any) => r.id)).toEqual([a.id]);
    // The stream shows the user what happened.
    const events = (await second.call("GET", `/api/agents/${a.id}/events`)).json;
    expect(events.some((e: any) => e.event.type === "output" && /resumed/i.test(e.event.data))).toBe(true);
  });

  it("does not resume agents that finished or were stopped by the user", async () => {
    const w = world();
    const first = await launch(w);
    const a = (await first.start("f/01")).json;
    await first.start("f/02");
    await first.call("POST", `/api/agents/${a.id}/stop`, {});
    await first.daemon.close();
    const second = await launch(w);
    expect(second.specs).toHaveLength(1);
    expect(second.specs[0]!.task).toContain("ticket 02");
  });

  it("keeps queued tickets queued across a restart", async () => {
    const w = world();
    const first = await launch(w);
    await first.start("f/01"); await first.start("f/02");
    expect((await first.start("f/03")).status).toBe(202);
    await first.daemon.close();
    const second = await launch(w);
    expect(second.specs).toHaveLength(2);
    const limits = (await second.call("GET", "/api/limits")).json;
    expect(limits.queued.map((q: any) => q.ticketKey)).toEqual(["03"]);
    // A finishing worker still frees the slot for the restored queue.
    await second.call("POST", `/api/agents/${second.specs[0]!.id}/stop`, {});
    await expect.poll(() => second.specs.length).toBe(3);
    expect(second.specs[2]!.task).toContain("ticket 03");
  });

  it("closes a question left open at exit, so the resumed agent asks again", async () => {
    const w = world();
    const first = await launch(w);
    const a = (await first.start("f/01")).json;
    const cfg = JSON.parse(readFileSync(first.specs[0]!.mcpConfig!, "utf8")).mcpServers.bridge;
    const client = new Client({ name: "test", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(cfg.url), { requestInit: { headers: cfg.headers } }));
    cleanups.push(() => client.close());
    void client.callTool({ name: "ask_user", arguments: { question: "Which database?" } }).catch(() => {});
    await expect.poll(async () => (await first.call("GET", "/api/inbox")).json.open).toBe(1);
    await first.daemon.close();
    const second = await launch(w);
    const inbox = (await second.call("GET", "/api/inbox")).json;
    expect(inbox.open).toBe(0);
    expect(inbox.items[0]).toMatchObject({ status: "resolved", decision: "deny", agentId: a.id });
    expect(inbox.items[0].reply).toMatch(/restart/i);
  });

  it("reports an agent that could not be stopped on exit, clearly", async () => {
    const w = world();
    const first = await launch(w, { stopThrows: true });
    const a = (await first.start("f/01")).json;
    first.working(a.id);
    await first.daemon.close();
    const exit = first.daemon.exit!;
    expect(exit.failed).toEqual([expect.objectContaining({ id: a.id, error: expect.stringContaining("Access is denied") })]);
    const second = await launch(w);
    const report = (await second.call("GET", "/api/restart")).json;
    expect(report.previousExit.failed[0]).toMatchObject({ id: a.id, ticketKey: "01" });
    expect(report.notice).toMatch(/could not be stopped/i);
    const events = (await second.call("GET", `/api/agents/${a.id}/events`)).json;
    expect(events.some((e: any) => e.event.type === "output" && /could not be stopped/i.test(e.event.data))).toBe(true);
  });

  it("reuses the ticket's clone and branch when resuming", async () => {
    const w = world(true);
    const first = await launch(w);
    const a = (await first.start("f/01")).json;
    const cwd = a.workspace.path;
    expect(existsSync(cwd)).toBe(true);
    first.working(a.id);
    await first.daemon.close();
    const second = await launch(w);
    expect(second.specs[0]!.cwd).toBe(cwd);
  });
});
