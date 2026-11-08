import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startDaemon } from "../src/server/daemon.ts";
import { createFakeAgentRunner } from "../src/server/fake-agent.ts";
import { createPtyAgentRunner } from "../src/server/pty-agent.ts";
import type { AgentEvent } from "../src/server/agent-runner.ts";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

const script: AgentEvent[] = [
  { type: "status", status: "working" },
  { type: "output", data: "Do you want to run `npm test`? (y/n)\r\n" },
  { type: "question", text: "Which database?" },
];

async function boot() {
  const dir = mkdtempSync(join(tmpdir(), "bridge-term-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const repo = join(dir, "repo");
  mkdirSync(join(repo, ".scratch", "f", "issues"), { recursive: true });
  writeFileSync(join(repo, ".scratch", "f", "issues", "01-thing.md"), "# 01: Do the thing\n\n**Status:** ready-for-agent\n");
  const daemon = await startDaemon({ dataDir: join(dir, "data"), runner: createFakeAgentRunner(script) });
  cleanups.push(() => daemon.close());
  const ws = new WebSocket(daemon.url.replace("http", "ws") + "/ws");
  const received: any[] = [];
  await new Promise((r) => ws.addEventListener("open", r, { once: true }));
  ws.addEventListener("message", (m) => received.push(JSON.parse(String(m.data))));
  cleanups.push(() => ws.close());
  const post = async (path: string, body: unknown) => {
    const r = await fetch(daemon.url + path, { method: "POST", body: JSON.stringify(body) });
    return { status: r.status, json: (await r.json()) as any };
  };
  const project = (await post("/api/projects", { name: "demo", path: repo })).json;
  return { daemon, ws, received, post, project };
}

describe("agent terminal via the public API", () => {
  it("starts an agent on a ticket and streams terminal output, prompts included", async () => {
    const { received, post, project, daemon } = await boot();
    const r = await post("/api/agents", { projectId: project.id, name: "Atlas", ticket: "f/01" });
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ ticketKey: "01", ticketTitle: "Do the thing" });
    await expect.poll(() => received.filter((m) => m.event?.type === "output").map((m) => m.event.data))
      .toEqual(["Do you want to run `npm test`? (y/n)\r\n"]);
    await expect.poll(() => received.some((m) => m.event?.type === "question")).toBe(true);
    const agents = (await (await fetch(`${daemon.url}/api/agents`)).json()) as any[];
    expect(agents[0]).toMatchObject({ ticketKey: "01", status: "working" });
    const stored = (await (await fetch(`${daemon.url}/api/agents/${r.json.id}/events`)).json()) as any[];
    expect(stored.some((e) => e.event.type === "output")).toBe(true);
  });

  it("rejects an unknown ticket", async () => {
    const { post, project } = await boot();
    expect((await post("/api/agents", { projectId: project.id, name: "A", ticket: "f/99" })).status).toBe(404);
  });

  it("delivers typed input to the agent over the WebSocket", async () => {
    const { received, post, project, ws } = await boot();
    const a = (await post("/api/agents", { projectId: project.id, name: "Atlas" })).json;
    ws.send(JSON.stringify({ type: "input", agentId: a.id, data: "yes\r" }));
    await expect.poll(() => received.some((m) => m.event?.type === "output" && m.event.data === "echo: yes\r")).toBe(true);
  });

  it("stops an agent and marks it done", async () => {
    const { received, post, project, daemon } = await boot();
    const a = (await post("/api/agents", { projectId: project.id, name: "Atlas" })).json;
    expect((await post(`/api/agents/${a.id}/stop`, {})).status).toBe(200);
    await expect.poll(async () => ((await (await fetch(`${daemon.url}/api/agents`)).json()) as any[])[0].status).toBe("done");
    expect(received.some((m) => m.event?.type === "status" && m.event.status === "done")).toBe(true);
    expect((await post("/api/agents/nope/stop", {})).status).toBe(404);
  });
});

describe("pty adapter contract", { timeout: 20000 }, () => {
  const slow = { timeout: 10000 };
  const collect = (runner: ReturnType<typeof createPtyAgentRunner>, id: string, args: string[]) => {
    const events: AgentEvent[] = [];
    const out = () => events.flatMap((e) => (e.type === "output" ? [e.data] : [])).join("");
    const runnerWithArgs = runner;
    runnerWithArgs.start({ id, name: "t", projectId: "p", task: args.join(" ") }, (e) => events.push(e));
    cleanups.push(() => runner.stop(id));
    return { events, out };
  };
  const mk = (script: string) => createPtyAgentRunner({ command: process.execPath, args: () => ["-e", script] });

  it("streams output and reports done on exit", async () => {
    const { events, out } = collect(mk("console.log('hello-pty')"), "a1", []);
    await expect.poll(out, slow).toContain("hello-pty");
    await expect.poll(() => events.some((e) => e.type === "status" && e.status === "done"), slow).toBe(true);
    expect(events[0]).toEqual({ type: "status", status: "working" });
  });

  it("passes written input to the process", async () => {
    const runner = mk("process.stdin.on('data',d=>{console.log('got:'+String(d).trim());process.exit(0)});console.log('ready')");
    const { out } = collect(runner, "a2", []);
    await expect.poll(out, slow).toContain("ready");
    runner.write("a2", "ping\r");
    await expect.poll(out, slow).toContain("got:ping");
  });

  it("stop halts a running process", async () => {
    const runner = mk("setInterval(()=>{},1000);console.log('up')");
    const { events, out } = collect(runner, "a3", []);
    await expect.poll(out, slow).toContain("up");
    runner.stop("a3");
    await expect.poll(() => events.some((e) => e.type === "status" && e.status === "done"), slow).toBe(true);
  });
});
