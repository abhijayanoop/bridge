import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startDaemon } from "../src/server/daemon.ts";
import { createFakeAgentRunner } from "../src/server/fake-agent.ts";
import type { AgentRunner, AgentSpec } from "../src/server/agent-runner.ts";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

async function boot() {
  const dir = mkdtempSync(join(tmpdir(), "bridge-inbox-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const repo = join(dir, "repo");
  mkdirSync(join(repo, ".scratch", "f", "issues"), { recursive: true });
  writeFileSync(join(repo, ".scratch", "f", "issues", "01-thing.md"), "# 01: Do the thing\n\n**Status:** ready-for-agent\n\nBody text here.\n");
  const specs: AgentSpec[] = [];
  const fake = createFakeAgentRunner([]);
  const runner: AgentRunner = { ...fake, start(spec, emit) { specs.push(spec); fake.start(spec, emit); } };
  const daemon = await startDaemon({ dataDir: join(dir, "data"), runner });
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
  const get = async (path: string) => (await fetch(daemon.url + path)).json() as Promise<any>;
  const project = (await post("/api/projects", { name: "demo", path: repo })).json;
  const startAgent = async (extra: object = {}) => {
    const r = await post("/api/agents", { projectId: project.id, name: "A", ...extra });
    const spec = specs.at(-1)!;
    const cfg = JSON.parse(readFileSync(spec.mcpConfig!, "utf8")).mcpServers.bridge;
    const client = new Client({ name: "test", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(cfg.url), { requestInit: { headers: cfg.headers } }));
    cleanups.push(() => client.close());
    const call = (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args }) as Promise<{ content: { text: string }[] }>;
    return { agent: r.json, spec, client, call };
  };
  const firstOpen = async () => { await expect.poll(async () => (await get("/api/inbox")).open).toBeGreaterThan(0); return (await get("/api/inbox")).items[0]; };
  return { daemon, received, post, get, repo, startAgent, firstOpen };
}

describe("agent tools and Inbox via the public API", () => {
  it("writes the MCP config alongside hook config without clobbering", async () => {
    const { repo, startAgent } = await boot();
    mkdirSync(join(repo, ".claude"), { recursive: true });
    writeFileSync(join(repo, ".claude", "settings.local.json"), JSON.stringify({ permissions: { allow: ["Bash(ls)"] } }));
    const { spec } = await startAgent();
    const settings = JSON.parse(readFileSync(join(repo, ".claude", "settings.local.json"), "utf8"));
    expect(settings.permissions.allow).toEqual(["Bash(ls)", "mcp__bridge"]);
    expect(JSON.stringify(settings.hooks)).toContain("bridge-hook.mjs");
    expect(existsSync(spec.mcpConfig!)).toBe(true);
  });

  it("lists the four tools and rejects a bad token", async () => {
    const { startAgent, daemon } = await boot();
    const { client, agent } = await startAgent();
    expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual(["ask_user", "get_my_ticket", "request_access", "set_my_status"]);
    const r = await fetch(`${daemon.url}/mcp/${agent.id}`, { method: "POST", headers: { "x-bridge-token": "nope" }, body: "{}" });
    expect(r.status).toBe(401);
  });

  it("get_my_ticket and set_my_status work", async () => {
    const { startAgent, get } = await boot();
    const { agent, call } = await startAgent({ ticket: "f/01" });
    const t = JSON.parse((await call("get_my_ticket")).content[0]!.text);
    expect(t.title).toBe("Do the thing");
    expect(t.body).toContain("Body text here.");
    await call("set_my_status", { status: "waiting" });
    expect((await get("/api/agents")).find((a: any) => a.id === agent.id).status).toBe("waiting");
  });

  it("ask_user blocks until Reply, and the badge count follows over WebSocket", async () => {
    const { startAgent, firstOpen, post, received } = await boot();
    const { agent, call } = await startAgent({ ticket: "f/01" });
    let settled = false;
    const pending = call("ask_user", { question: "Custom interval?", why: "Spec is silent" }).then((r) => { settled = true; return r; });
    const item = await firstOpen();
    expect(item).toMatchObject({ kind: "question", agentId: agent.id, what: "Custom interval?", why: "Spec is silent", ticketKey: "01", status: "open" });
    await expect.poll(() => received.some((m) => m.type === "inbox" && m.open === 1)).toBe(true);
    expect(settled).toBe(false);
    expect((await post(`/api/inbox/${item.id}/resolve`, { decision: "reply", text: "Yes, add it" })).status).toBe(200);
    expect((await pending).content[0]!.text).toBe("Yes, add it");
    await expect.poll(() => received.some((m) => m.type === "inbox" && m.open === 0)).toBe(true);
    expect((await post(`/api/inbox/${item.id}/resolve`, { decision: "approve" })).status).toBe(404);
  });

  it("request_access delivers Approve and Deny to the waiting agent", async () => {
    const { startAgent, firstOpen, post, get } = await boot();
    const { call } = await startAgent();
    const a = call("request_access", { kind: "domain", detail: "registry.npmjs.org", why: "install" });
    const item = await firstOpen();
    expect(item).toMatchObject({ kind: "access", access: "domain", facts: [{ k: "Domain", v: "registry.npmjs.org" }] });
    await post(`/api/inbox/${item.id}/resolve`, { decision: "approve" });
    expect((await a).content[0]!.text).toContain("Approved");

    const b = call("request_access", { kind: "push", detail: "feature-x" });
    await expect.poll(async () => (await get("/api/inbox")).open).toBe(1);
    const second = (await get("/api/inbox")).items[0];
    await post(`/api/inbox/${second.id}/resolve`, { decision: "deny", text: "not yet" });
    expect((await b).content[0]!.text).toBe("Denied: Push feature-x. Reason: not yet");
    const all = await get("/api/inbox");
    expect(all.open).toBe(0);
    expect(all.items.map((i: any) => i.decision)).toEqual(["deny", "approve"]);
  });

  it("rejects an empty reply", async () => {
    const { startAgent, firstOpen, post } = await boot();
    const { call } = await startAgent();
    call("ask_user", { question: "?" }).catch(() => {});
    const item = await firstOpen();
    expect((await post(`/api/inbox/${item.id}/resolve`, { decision: "reply", text: " " })).status).toBe(400);
  });
});
