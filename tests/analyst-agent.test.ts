import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startDaemon } from "../src/server/daemon.ts";
import { createFakeAgentRunner } from "../src/server/fake-agent.ts";
import { createFakeDataSource } from "../src/server/fake-datasource.ts";
import type { AgentRunner, AgentSpec } from "../src/server/agent-runner.ts";
import { SAMPLE_CONNECTION_STRING, SAMPLE_TABLES } from "./fixtures/sample-db.ts";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

async function boot() {
  const dir = mkdtempSync(join(tmpdir(), "bridge-analyst-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const repo = join(dir, "repo");
  mkdirSync(repo, { recursive: true });
  const specs: AgentSpec[] = [];
  const fake = createFakeAgentRunner([]);
  const runner: AgentRunner = { ...fake, start(spec, emit) { specs.push(spec); fake.start(spec, emit); } };
  const dataSource = createFakeDataSource(SAMPLE_TABLES);
  const dataDir = join(dir, "data");
  const daemon = await startDaemon({ dataDir, runner, dataSource });
  cleanups.push(() => daemon.close().catch(() => {}));
  const ws = new WebSocket(daemon.url.replace("http", "ws") + "/ws");
  const received: string[] = [];
  await new Promise((r) => ws.addEventListener("open", r, { once: true }));
  ws.addEventListener("message", (m) => received.push(String(m.data)));
  cleanups.push(() => ws.close());
  const send = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(daemon.url + path, { method, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, text: await r.clone().text(), json: (await r.json()) as any };
  };
  const post = (path: string, body: unknown) => send("POST", path, body);
  const get = (path: string) => send("GET", path);
  const project = (await post("/api/projects", { name: "demo", path: repo })).json;
  const addConnection = async (extra: object = {}) =>
    (await post(`/api/projects/${project.id}/connections`, { kind: "postgres", label: "shop", connectionString: SAMPLE_CONNECTION_STRING, ...extra })).json;
  const enable = (id: string, extra: object = {}) => post(`/api/connections/${id}`, { enabled: true, ...extra });
  const startAnalyst = async () => {
    const r = await post(`/api/projects/${project.id}/analyst`, {});
    if (r.status !== 201) return { r };
    const spec = specs.at(-1)!;
    const cfg = JSON.parse(readFileSync(spec.mcpConfig!, "utf8")).mcpServers.bridge;
    const client = new Client({ name: "test", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(cfg.url), { requestInit: { headers: cfg.headers } }));
    cleanups.push(() => client.close());
    const call = (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args }) as Promise<{ content: { text: string }[] }>;
    return { r, spec, client, call };
  };
  const resolveNext = async (decision: string, scope = "once") => {
    await expect.poll(async () => (await get("/api/inbox")).json.open).toBeGreaterThan(0);
    const item = (await get("/api/inbox")).json.items.find((i: any) => i.status === "open");
    await post(`/api/inbox/${item.id}/resolve`, { decision, scope });
    return item;
  };
  return { runner, daemon, dataDir, dataSource, specs, received, post, get, send, project, addConnection, enable, startAnalyst, resolveNext, dir };
}

describe("Analyst agent", () => {
  it("is disabled until a connection is enabled in settings", async () => {
    const { post, project, addConnection, enable } = await boot();
    expect((await post(`/api/projects/${project.id}/analyst`, {})).status).toBe(409);
    const c = await addConnection();
    expect(c.enabled).toBe(false);
    expect((await post(`/api/projects/${project.id}/analyst`, {})).status).toBe(409);
    await enable(c.id);
    expect((await post(`/api/projects/${project.id}/analyst`, {})).status).toBe(201);
  });

  it("is an agent of its own type that uses no worker slot and gets only its own tools", async () => {
    const { addConnection, enable, startAnalyst, get } = await boot();
    const c = await addConnection();
    await enable(c.id);
    const { r, client } = await startAnalyst();
    expect(r.json.analyst).toBe(true);
    expect(r.json.ticketId).toBeNull();
    expect((await get("/api/limits")).json.running).toBe(0);
    const names = (await client!.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(["ask_user", "get_my_ticket", "list_datasets", "query_dataset", "request_access", "set_my_status"]);
  });

  it("lists datasets without asking and never hands over credentials", async () => {
    const { addConnection, enable, startAnalyst } = await boot();
    const c = await addConnection();
    await enable(c.id);
    const { call } = await startAnalyst();
    const text = (await call!("list_datasets")).content[0]!.text;
    expect(text).toContain("customers");
    expect(text).toContain("invoices");
    expect(text).not.toContain("s3cret-sample-pw");
  });

  it("blocks on an Inbox approval per dataset and returns masked rows", async () => {
    const { addConnection, enable, startAnalyst, resolveNext, get, dataSource } = await boot();
    const c = await addConnection();
    await enable(c.id);
    const { call } = await startAnalyst();
    const pending = call!("query_dataset", { connection: "shop", datasets: ["customers"], query: "SELECT name, email, city, invoices_per_year FROM customers" });
    const item = await resolveNext("approve");
    expect(item.access).toBe("database");
    expect(item.detail).toBe("shop/customers");
    expect(item.facts.some((f: any) => /masked/i.test(f.v))).toBe(true);
    const out = (await pending).content[0]!.text;
    expect(out).not.toContain("Ada Lovelace");
    expect(out).not.toContain("example.invalid");
    expect(out).toContain("London");
    expect(out).toContain("12");
    // The same person appears twice, so the pseudonym is the same: grouping still works.
    const rows = JSON.parse(out).rows as { name: string }[];
    expect(rows[0]!.name).toBe(rows[2]!.name);
    expect(rows[0]!.name).not.toBe(rows[1]!.name);
    // The credential reached the data source (host side) and nowhere else.
    expect(dataSource.calls.at(-1)!.secret).toBe(SAMPLE_CONNECTION_STRING);
    expect((await get("/api/inbox")).json.items.length).toBe(1);
  });

  it("runs nothing when the user denies the dataset", async () => {
    const { addConnection, enable, startAnalyst, resolveNext, dataSource } = await boot();
    const c = await addConnection();
    await enable(c.id);
    const { call } = await startAnalyst();
    const pending = call!("query_dataset", { connection: "shop", datasets: ["customers"], query: "SELECT * FROM customers" });
    await resolveNext("deny");
    expect((await pending).content[0]!.text).toMatch(/denied/i);
    expect(dataSource.calls.filter((x) => x.kind === "query")).toHaveLength(0);
  });

  it("a whole-project approval covers later queries on that dataset only", async () => {
    const { addConnection, enable, startAnalyst, resolveNext, get } = await boot();
    const c = await addConnection();
    await enable(c.id);
    const { call } = await startAnalyst();
    const first = call!("query_dataset", { connection: "shop", datasets: ["customers"], query: "SELECT city FROM customers" });
    await resolveNext("approve", "project");
    await first;
    const again = (await call!("query_dataset", { connection: "shop", datasets: ["customers"], query: "SELECT city FROM customers" })).content[0]!.text;
    expect(JSON.parse(again).rows.length).toBe(3);
    expect((await get("/api/inbox")).json.items.length).toBe(1);
    // A different dataset still needs its own approval.
    const other = call!("query_dataset", { connection: "shop", datasets: ["invoices"], query: "SELECT total FROM invoices" });
    const item = await resolveNext("deny");
    expect(item.detail).toBe("shop/invoices");
    await other;
  });

  it("refuses writes and tables that were not approved, before any approval is raised", async () => {
    const { addConnection, enable, startAnalyst, get, dataSource } = await boot();
    const c = await addConnection();
    await enable(c.id);
    const { call } = await startAnalyst();
    for (const query of [
      "DELETE FROM customers",
      "SELECT 1; DROP TABLE customers",
      "UPDATE customers SET name = 'x'",
      "SELECT * FROM customers JOIN secrets ON true",
      "SELECT * FROM customers, secrets",
      "WITH s AS (SELECT * FROM secrets) SELECT * FROM s",
      "SELECT * FROM customers; -- ok",
    ]) {
      const t = (await call!("query_dataset", { connection: "shop", datasets: ["customers"], query })).content[0]!.text;
      expect(t, query).toMatch(/refused/i);
    }
    expect((await get("/api/inbox")).json.items.length).toBe(0);
    expect(dataSource.calls.filter((x) => x.kind === "query")).toHaveLength(0);
  });

  it("allows plain reporting SQL and keeps MongoDB to one collection with no writing stages", async () => {
    const { addConnection, enable, startAnalyst, resolveNext, dataSource } = await boot();
    const pg = await addConnection();
    const mongo = await addConnection({ kind: "mongodb", label: "events", connectionString: "mongodb+srv://reader:pw-mongo@cluster.example.invalid/shop" });
    await enable(pg.id); await enable(mongo.id);
    const { call } = await startAnalyst();
    const ok = call!("query_dataset", { connection: "shop", datasets: ["customers"], query: "SELECT city, count(*) AS n, extract(year FROM now()) AS y FROM public.customers c WHERE city <> 'update' GROUP BY city ORDER BY n DESC;" });
    await resolveNext("approve");
    expect(JSON.parse((await ok).content[0]!.text).rows.length).toBe(3);
    for (const query of ['[{"$out":"copy"}]', '[{"$lookup":{"from":"secrets"}}]', '{"$match":{}}', "not json"]) {
      const t = (await call!("query_dataset", { connection: "events", datasets: ["customers"], query })).content[0]!.text;
      expect(t, query).toMatch(/refused/i);
    }
    expect((await call!("query_dataset", { connection: "events", datasets: ["a", "b"], query: "[]" })).content[0]!.text).toMatch(/refused/i);
    const good = call!("query_dataset", { connection: "events", datasets: ["customers"], query: '[{"$match":{"city":"London"}}]' });
    await resolveNext("approve");
    expect(JSON.parse((await good).content[0]!.text).rows.length).toBe(3);
    expect(dataSource.calls.filter((x) => x.kind === "query").map((x) => x.secret)).toContain("mongodb+srv://reader:pw-mongo@cluster.example.invalid/shop");
  });

  it("while masking is on, refuses queries that would reshape a name or identifier past the masking", async () => {
    const { addConnection, enable, startAnalyst, get, dataSource } = await boot();
    const c = await addConnection();
    await enable(c.id);
    const { call } = await startAnalyst();
    for (const query of [
      "SELECT name AS label FROM customers",
      "SELECT lower(name) FROM customers",
      "SELECT array_agg(name) FROM customers",
      "SELECT name || '' FROM customers",
      "SELECT city FROM customers WHERE name = 'Ada Lovelace'",
      "SELECT count(DISTINCT email) FROM customers",
      "SELECT n FROM (SELECT name AS n FROM customers) s",
      "SELECT cast(name AS text) FROM customers",
    ]) expect((await call!("query_dataset", { connection: "shop", datasets: ["customers"], query })).content[0]!.text, query).toMatch(/refused/i);
    expect((await get("/api/inbox")).json.items.length).toBe(0);
    expect(dataSource.calls.filter((x) => x.kind === "query")).toHaveLength(0);
  });

  it("refuses ways of hiding a table read from the guard", async () => {
    const { addConnection, enable, startAnalyst } = await boot();
    const c = await addConnection();
    await enable(c.id, { maskingOn: false });
    const { call } = await startAnalyst();
    for (const query of [
      `SELECT 1 AS "a'", (SELECT count(*) FROM secrets), 2 AS "b'" FROM customers`,
      "SELECT * FROM customers UNION TABLE secrets",
      "SELECT * FROM other_schema.customers",
      "SELECT * FROM public.secrets.customers",
      "SELECT * FROM customers WHERE EXISTS (TABLE secrets)",
      "SELECT pg_read_file('/etc/passwd')",
      "SELECT 'a' || E'\\\\' FROM customers",
    ]) expect((await call!("query_dataset", { connection: "shop", datasets: ["customers"], query })).content[0]!.text, query).toMatch(/refused/i);
  });

  it("with masking off, the same expressions are allowed", async () => {
    const { addConnection, enable, startAnalyst, resolveNext } = await boot();
    const c = await addConnection();
    await enable(c.id, { maskingOn: false });
    const { call } = await startAnalyst();
    const p = call!("query_dataset", { connection: "shop", datasets: ["customers"], query: "SELECT lower(name) AS who FROM customers" });
    await resolveNext("approve");
    expect((await p).content[0]!.text).toContain("Ada Lovelace");
  });

  it("keeps row values out of database errors while masking is on", async () => {
    const { addConnection, enable, startAnalyst, resolveNext, dataSource } = await boot();
    const c = await addConnection();
    await enable(c.id);
    dataSource.failWith(`invalid input syntax for type integer: "Ada Lovelace" (DETAIL: Key (email)=(ada@example.invalid) is bad)`);
    const { call } = await startAnalyst();
    const p = call!("query_dataset", { connection: "shop", datasets: ["customers"], query: "SELECT city FROM customers" });
    await resolveNext("approve");
    const t = (await p).content[0]!.text;
    expect(t).toMatch(/failed/i);
    expect(t).not.toContain("Ada Lovelace");
    expect(t).not.toContain("example.invalid");
  });

  it("rejects a role that can write, whatever the wizard said", async () => {
    const { post, project, dataSource } = await boot();
    dataSource.canWrite("the role can write: INSERT on customers");
    const r = await post(`/api/projects/${project.id}/connections`, { kind: "postgres", label: "shop", connectionString: SAMPLE_CONNECTION_STRING });
    expect(r.status).toBe(400);
    expect(r.text).toMatch(/not read-only/);
    expect(r.text).toContain("INSERT on customers");
  });

  it("MongoDB: only listed read stages, and masking blocks reshaping identifiers", async () => {
    const { addConnection, enable, startAnalyst } = await boot();
    const m = await addConnection({ kind: "mongodb", label: "events", connectionString: "mongodb://reader:pw@h.example.invalid/shop" });
    await enable(m.id);
    const { call } = await startAnalyst();
    for (const query of [
      '[{"$documents":[{"a":1}]}]',
      '[{"$project":{"label":"$name"}}]',
      '[{"$match":{"email":"ada@example.invalid"}}]',
      '[{"$group":{"_id":"$city","who":{"$push":"$name"}}}]',
      '[{"$match":{}, "$out":"x"}]',
      JSON.stringify(Array.from({ length: 13 }, () => ({ $limit: 5 }))),
    ]) expect((await call!("query_dataset", { connection: "events", datasets: ["customers"], query })).content[0]!.text, query).toMatch(/refused/i);
  });

  it("masking can be turned off only by an explicit setting on that connection", async () => {
    const { addConnection, enable, startAnalyst, resolveNext } = await boot();
    const c = await addConnection();
    expect(c.maskingOn).toBe(true);
    await enable(c.id, { maskingOn: false });
    const { call } = await startAnalyst();
    const pending = call!("query_dataset", { connection: "shop", datasets: ["customers"], query: "SELECT name FROM customers" });
    await resolveNext("approve");
    expect((await pending).content[0]!.text).toContain("Ada Lovelace");
  });

  it("a disabled connection stops answering even for a running Analyst", async () => {
    const { addConnection, enable, startAnalyst, post } = await boot();
    const c = await addConnection();
    await enable(c.id);
    const { call } = await startAnalyst();
    await post(`/api/connections/${c.id}`, { enabled: false });
    const t = (await call!("query_dataset", { connection: "shop", datasets: ["customers"], query: "SELECT city FROM customers" })).content[0]!.text;
    expect(t).toMatch(/not enabled|disabled/i);
  });

  it("keeps the credential on the host: not in the API, the agent's spec, its tool config, or WebSocket messages", async () => {
    const { addConnection, enable, startAnalyst, get, received, specs, dataDir, project, resolveNext } = await boot();
    const c = await addConnection();
    await enable(c.id);
    const { spec, call } = await startAnalyst();
    const pending = call!("query_dataset", { connection: "shop", datasets: ["customers"], query: "SELECT city FROM customers" });
    await expect.poll(async () => (await get("/api/inbox")).json.open).toBeGreaterThan(0);
    const secret = "s3cret-sample-pw";
    expect(JSON.stringify(c)).not.toContain(secret);
    expect((await get(`/api/projects/${project.id}/connections`)).text).not.toContain(secret);
    expect((await get("/api/agents")).text).not.toContain(secret);
    expect((await get("/api/inbox")).text).not.toContain(secret);
    expect(JSON.stringify(spec)).not.toContain(secret);
    expect(JSON.stringify(specs)).not.toContain(secret);
    expect(readFileSync(spec!.mcpConfig!, "utf8")).not.toContain(secret);
    expect(received.join("\n")).not.toContain(secret);
    expect(readFileSync(join(dataDir, "bridge.db")).includes(Buffer.from(secret))).toBe(false);
    // It lives in its own file under the data dir.
    const files = existsSync(join(dataDir, "secrets")) ? readdirSync(join(dataDir, "secrets")) : [];
    expect(files).toHaveLength(1);
    if (process.platform !== "win32") expect(statSync(join(dataDir, "secrets", files[0]!)).mode & 0o077).toBe(0);
    await resolveNext("deny");
    await pending;
  });

  it("scrubs the credential from errors the database raises", async () => {
    const { addConnection, enable, startAnalyst, resolveNext, dataSource } = await boot();
    const c = await addConnection();
    await enable(c.id);
    dataSource.failWith(`connection to ${SAMPLE_CONNECTION_STRING} refused`);
    const { call } = await startAnalyst();
    const pending = call!("query_dataset", { connection: "shop", datasets: ["customers"], query: "SELECT city FROM customers" });
    await resolveNext("approve");
    const t = (await pending).content[0]!.text;
    expect(t).toMatch(/failed/i);
    expect(t).not.toContain("s3cret-sample-pw");
  });

  it("checks the connection when it is saved and rejects one that does not work", async () => {
    const { post, project, dataSource } = await boot();
    dataSource.failWith("password authentication failed");
    const r = await post(`/api/projects/${project.id}/connections`, { kind: "postgres", label: "bad", connectionString: SAMPLE_CONNECTION_STRING });
    expect(r.status).toBe(400);
    expect(r.text).toMatch(/password authentication failed/);
    expect(r.text).not.toContain("s3cret-sample-pw");
  });

  it("validates new connections", async () => {
    const { post, project, addConnection } = await boot();
    expect((await post(`/api/projects/${project.id}/connections`, { kind: "mysql", label: "x", connectionString: "x" })).status).toBe(400);
    expect((await post(`/api/projects/${project.id}/connections`, { kind: "postgres", label: "", connectionString: "x" })).status).toBe(400);
    await addConnection();
    expect((await post(`/api/projects/${project.id}/connections`, { kind: "postgres", label: "shop", connectionString: SAMPLE_CONNECTION_STRING })).status).toBe(409);
    expect((await post(`/api/projects/nope/connections`, { kind: "postgres", label: "y", connectionString: "x" })).status).toBe(404);
  });

  it("deleting a connection removes its stored credential", async () => {
    const { addConnection, send, dataDir } = await boot();
    const c = await addConnection();
    expect(readdirSync(join(dataDir, "secrets"))).toHaveLength(1);
    expect((await send("DELETE", `/api/connections/${c.id}`)).status).toBe(200);
    expect(readdirSync(join(dataDir, "secrets"))).toHaveLength(0);
  });

  it("the role-setup wizard previews read-only steps and changes nothing", async () => {
    const { post, project, dataDir, get } = await boot();
    const pg = await post(`/api/projects/${project.id}/connections/role-setup`, { kind: "postgres", database: "shop", role: "bridge_analyst", tables: ["customers", "invoices"] });
    expect(pg.status).toBe(200);
    const sql = pg.json.steps.map((s: any) => s.run).join("\n");
    expect(sql).toMatch(/CREATE ROLE bridge_analyst LOGIN/);
    expect(sql).toMatch(/default_transaction_read_only = on/);
    expect(sql).toMatch(/GRANT SELECT ON .*customers.*invoices.* TO bridge_analyst/s);
    expect(sql).not.toMatch(/INSERT|UPDATE|DELETE|ALL PRIVILEGES|SUPERUSER/i);
    const mongo = await post(`/api/projects/${project.id}/connections/role-setup`, { kind: "mongodb", database: "shop", role: "bridge_analyst" });
    expect(mongo.json.steps.map((s: any) => s.run).join("\n")).toMatch(/role: "read"/);
    expect((await post(`/api/projects/${project.id}/connections/role-setup`, { kind: "postgres", database: "shop; DROP", role: "x" })).status).toBe(400);
    expect(existsSync(join(dataDir, "secrets"))).toBe(false);
    expect((await get(`/api/projects/${project.id}/connections`)).json.connections).toEqual([]);
  });

  it("starts in its own empty folder with a one-line task, and resumes there after a restart", async () => {
    const { addConnection, enable, startAnalyst, dir, specs, daemon, runner, dataDir, dataSource, project } = await boot();
    const c = await addConnection();
    await enable(c.id);
    const { r } = await startAnalyst();
    expect(r.json.ticketId).toBeNull();
    const first = specs.at(-1)!;
    expect(first.task).toMatch(/list_datasets/);
    expect(first.task).not.toContain("\n");
    expect(first.cwd).not.toBe(join(dir, "repo"));
    expect(first.cwd).toContain(join(dataDir, "analyst"));
    await daemon.close();
    const again = await startDaemon({ dataDir, runner, dataSource });
    cleanups.push(() => again.close().catch(() => {}));
    const resumed = specs.at(-1)!;
    expect(specs.length).toBe(2);
    expect(resumed.cwd).toBe(first.cwd);
    expect(resumed.task).toMatch(/restarted/);
    expect(resumed.id).toBe(r.json.id);
    void project;
  });

  it("refuses a second Analyst while one is running, and an unknown project", async () => {
    const { addConnection, enable, startAnalyst, post, project } = await boot();
    const c = await addConnection();
    await enable(c.id);
    await startAnalyst();
    expect((await post(`/api/projects/${project.id}/analyst`, {})).status).toBe(409);
    expect((await post(`/api/projects/nope/analyst`, {})).status).toBe(404);
  });
});

describe("masking", () => {
  it("masks identifiers inside nested documents and email-looking values in any column", async () => {
    const { maskRows } = await import("../src/server/masking.ts");
    const rows = maskRows([{ _id: "507f1f77bcf86cd799439011", profile: { full_name: "Grace Hopper", tier: "gold" }, note: "mail grace@example.invalid", total: 5 }]);
    const text = JSON.stringify(rows);
    expect(text).not.toContain("Grace Hopper");
    expect(text).not.toContain("507f1f77bcf86cd799439011");
    expect(text).not.toContain("grace@example.invalid");
    expect(text).toContain("gold");
    expect(rows[0]!.total).toBe(5);
  });
});
