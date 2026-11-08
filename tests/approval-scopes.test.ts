import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  const dir = mkdtempSync(join(tmpdir(), "bridge-approvals-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const repo = join(dir, "repo");
  mkdirSync(join(repo, ".scratch", "f", "issues"), { recursive: true });
  for (const n of ["01", "02"]) writeFileSync(join(repo, ".scratch", "f", "issues", `${n}-t.md`), `# ${n}: Thing ${n}\n\n**Status:** ready-for-agent\n`);
  const specs: AgentSpec[] = [];
  const fake = createFakeAgentRunner([]);
  const runner: AgentRunner = { ...fake, start(spec, emit) { specs.push(spec); fake.start(spec, emit); } };
  // A rule the user already owns: Bridge must never remove it.
  const rules = new Set<string>(["user-owned.example"]);
  const networkRules = { add: (d: string) => { if (rules.has(d)) return false; rules.add(d); return true; }, remove: (d: string) => { rules.delete(d); } };
  const daemon = await startDaemon({ dataDir: join(dir, "data"), runner, networkRules });
  cleanups.push(() => daemon.close());
  const post = async (path: string, body: unknown) => {
    const r = await fetch(daemon.url + path, { method: "POST", body: JSON.stringify(body) });
    return { status: r.status, json: (await r.json()) as any };
  };
  const get = async (path: string) => (await fetch(daemon.url + path)).json() as Promise<any>;
  const del = async (path: string) => { const r = await fetch(daemon.url + path, { method: "DELETE" }); return { status: r.status, json: (await r.json()) as any }; };
  const project = (await post("/api/projects", { name: "demo", path: repo })).json;
  const startAgent = async (ticket: string) => {
    await post("/api/agents", { projectId: project.id, name: "A", ...(ticket ? { ticket } : {}) });
    const spec = specs.at(-1)!;
    const cfg = JSON.parse(readFileSync(spec.mcpConfig!, "utf8")).mcpServers.bridge;
    const client = new Client({ name: "test", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(cfg.url), { requestInit: { headers: cfg.headers } }));
    cleanups.push(() => client.close());
    const call = async (args: Record<string, unknown>) => ((await client.callTool({ name: "request_access", arguments: args })) as any).content[0].text as string;
    return { call };
  };
  /** Asks for access and answers the resulting Inbox item. */
  const ask = async (call: (a: any) => Promise<string>, args: any, answer: object) => {
    const before = (await get("/api/inbox")).items.length;
    const p = call(args);
    await expect.poll(async () => (await get("/api/inbox")).items.length).toBe(before + 1);
    const item = (await get("/api/inbox")).items[0];
    await post(`/api/inbox/${item.id}/resolve`, answer);
    return { text: await p, item };
  };
  const pendingOpen = async () => (await get("/api/inbox")).open as number;
  const active = async () => (await get("/api/approvals")).filter((a: any) => !a.revokedAt) as any[];
  return { post, get, del, startAgent, ask, rules, pendingOpen, active, repo };
}

describe("approval scopes and rules via the public API", () => {
  it("Once approves one request and asks again next time", async () => {
    const { startAgent, ask } = await boot();
    const { call } = await startAgent("f/01");
    const args = { kind: "secret", detail: "STRIPE_KEY" };
    expect((await ask(call, args, { decision: "approve", scope: "once" })).text).toContain("Approved");
    expect((await ask(call, args, { decision: "deny" })).text).toContain("Denied");
  });

  it("Ticket scope covers the same request from that ticket only", async () => {
    const { startAgent, ask, pendingOpen } = await boot();
    const one = await startAgent("f/01");
    const args = { kind: "push", detail: "feature-x" };
    await ask(one.call, args, { decision: "approve", scope: "ticket" });
    expect(await one.call(args)).toContain("Approved");
    expect(await pendingOpen()).toBe(0);
    const two = await startAgent("f/02");
    expect((await ask(two.call, args, { decision: "deny" })).text).toContain("Denied");
  });

  it("Project scope covers every ticket in the project", async () => {
    const { startAgent, ask, pendingOpen } = await boot();
    const one = await startAgent("f/01");
    await ask(one.call, { kind: "database", detail: "staging-db" }, { decision: "approve", scope: "project" });
    const two = await startAgent("f/02");
    expect(await two.call({ kind: "database", detail: "staging-db" })).toContain("Approved");
    expect(await pendingOpen()).toBe(0);
  });

  it("undo makes the next request ask again", async () => {
    const { startAgent, ask, active, del } = await boot();
    const { call } = await startAgent("f/01");
    const args = { kind: "secret", detail: "API_KEY" };
    await ask(call, args, { decision: "approve", scope: "project" });
    const [grant] = await active();
    expect((await del(`/api/approvals/${grant.id}`)).status).toBe(200);
    expect((await ask(call, args, { decision: "deny" })).text).toContain("Denied");
    expect((await del(`/api/approvals/${grant.id}`)).status).toBe(404);
  });

  it("new domains, secrets, pushes and databases all need approval", async () => {
    const { startAgent, ask } = await boot();
    const { call } = await startAgent("f/01");
    for (const [kind, detail] of [["domain", "new.example"], ["secret", "TOKEN"], ["push", "main"], ["database", "prod"]]) {
      const { item } = await ask(call, { kind, detail }, { decision: "deny" });
      expect(item).toMatchObject({ kind: "access", access: kind });
    }
  });

  it("rejects a ticket scope for an agent without a ticket, and unknown scopes", async () => {
    const { startAgent, post, get } = await boot();
    const { call } = await startAgent("");
    const p = call({ kind: "secret", detail: "X" });
    await expect.poll(async () => (await get("/api/inbox")).open).toBe(1);
    const item = (await get("/api/inbox")).items[0];
    expect((await post(`/api/inbox/${item.id}/resolve`, { decision: "approve", scope: "ticket" })).status).toBe(400);
    expect((await post(`/api/inbox/${item.id}/resolve`, { decision: "approve", scope: "forever" })).status).toBe(400);
    await post(`/api/inbox/${item.id}/resolve`, { decision: "deny" });
    await p;
  });

  it("removes only the network rules Bridge added", async () => {
    const { startAgent, ask, active, del, rules } = await boot();
    const { call } = await startAgent("f/01");
    await ask(call, { kind: "domain", detail: "user-owned.example" }, { decision: "approve", scope: "project" });
    await ask(call, { kind: "domain", detail: "registry.npmjs.org" }, { decision: "approve", scope: "project" });
    expect(rules.has("registry.npmjs.org")).toBe(true);
    for (const g of await active()) await del(`/api/approvals/${g.id}`);
    expect(rules.has("registry.npmjs.org")).toBe(false);
    expect(rules.has("user-owned.example")).toBe(true);
  });

  it("keeps a shared domain rule until its last grant is undone", async () => {
    const { startAgent, ask, active, del, rules } = await boot();
    const one = await startAgent("f/01");
    await ask(one.call, { kind: "domain", detail: "cdn.example" }, { decision: "approve", scope: "ticket" });
    const two = await startAgent("f/02");
    await ask(two.call, { kind: "domain", detail: "cdn.example" }, { decision: "approve", scope: "ticket" });
    const [a, b] = await active();
    await del(`/api/approvals/${a!.id}`);
    expect(rules.has("cdn.example")).toBe(true);
    await del(`/api/approvals/${b!.id}`);
    expect(rules.has("cdn.example")).toBe(false);
  });
});

describe("merging is never allowed", () => {
  it("refuses a merge access request without raising an Inbox item", async () => {
    const { startAgent, pendingOpen } = await boot();
    const { call } = await startAgent("f/01");
    expect(await call({ kind: "merge", detail: "feature-x into main" })).toMatch(/Refused.*merge/i);
    expect(await pendingOpen()).toBe(0);
  });

  it("blocks merge commands in the agent's hook and lets other commands through", async () => {
    const { startAgent, repo } = await boot();
    await startAgent("f/01");
    const script = join(repo, ".claude", "bridge-hook.mjs");
    const run = (command: string) => new Promise<{ status: number | null; stderr: string }>((resolve) => {
      // Async: the daemon runs in this process, so a blocking spawn would starve it.
      const child = spawn(process.execPath, [script, "working"]);
      let stderr = "";
      child.stderr.on("data", (c) => { stderr += c; });
      child.on("close", (status) => resolve({ status, stderr }));
      child.stdin.end(JSON.stringify({ tool_name: "Bash", tool_input: { command } }));
    });
    for (const c of ["gh pr merge 12 --squash", "git merge feature-x", "git  merge --no-ff x", "cd x && gh pr merge 3", "git --no-pager merge x", "git -c core.editor=true merge x"]) {
      const r = await run(c);
      expect(r.status, c).toBe(2);
      expect(r.stderr).toMatch(/merge/i);
    }
    for (const c of ["git status", "git merge-base main x", "git commit -m \"merge conflict notes\"", "npm test"]) expect((await run(c)).status, c).toBe(0);
  }, 30_000); // each hook run can wait out the script's 1.5s stdin fallback
});
