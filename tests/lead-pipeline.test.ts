import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { openStore } from "../src/server/db.ts";
import { startDaemon } from "../src/server/daemon.ts";
import { createFakeAgentRunner } from "../src/server/fake-agent.ts";
import type { AgentRunner, AgentSpec } from "../src/server/agent-runner.ts";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

async function boot(existing?: { dir: string }) {
  const dir = existing?.dir ?? mkdtempSync(join(tmpdir(), "bridge-lead-"));
  if (!existing) cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const repo = join(dir, "repo");
  mkdirSync(repo, { recursive: true });
  const specs: AgentSpec[] = [];
  const fake = createFakeAgentRunner([]);
  const runner: AgentRunner = { ...fake, start(spec, emit) { specs.push(spec); fake.start(spec, emit); } };
  const daemon = await startDaemon({ dataDir: join(dir, "data"), runner });
  cleanups.push(() => daemon.close().catch(() => {}));
  const post = async (path: string, body: unknown) => {
    const r = await fetch(daemon.url + path, { method: "POST", body: JSON.stringify(body) });
    return { status: r.status, json: (await r.json()) as any };
  };
  const get = async (path: string) => (await fetch(daemon.url + path)).json() as Promise<any>;
  const projects = await get("/api/projects");
  const project = projects[0] ?? (await post("/api/projects", { name: "demo", path: repo })).json;
  const toolsOf = async (spec: AgentSpec) => {
    const cfg = JSON.parse(readFileSync(spec.mcpConfig!, "utf8")).mcpServers.bridge;
    const client = new Client({ name: "test", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(cfg.url), { requestInit: { headers: cfg.headers } }));
    cleanups.push(() => client.close().catch(() => {}));
    return {
      client,
      call: (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args }) as Promise<{ content: { text: string }[] }>,
    };
  };
  /** Starts a feature and connects to its lead's tools. */
  const startFeature = async (description = "Add dark mode") => {
    const r = await post(`/api/projects/${project.id}/features`, { description });
    const lead = r.status === 201 ? await toolsOf(specs.at(-1)!) : undefined;
    return { ...r, lead };
  };
  const writeSpec = (slug: string) => {
    mkdirSync(join(repo, ".scratch", slug), { recursive: true });
    writeFileSync(join(repo, ".scratch", slug, "spec.md"), "# Dark mode\n\nUsers can switch theme.\n");
  };
  const writeTicket = (slug: string, n: string, title: string, blockedBy = "none") => {
    mkdirSync(join(repo, ".scratch", slug, "issues"), { recursive: true });
    writeFileSync(join(repo, ".scratch", slug, "issues", `${n}-${title.toLowerCase().replace(/\W+/g, "-")}.md`),
      `# ${n}: ${title}\n\n**Status:** ready-for-agent\n\n**Blocked by:** ${blockedBy}\n\n- [ ] done\n`);
  };
  const nextOpen = async () => {
    await expect.poll(async () => (await get("/api/inbox")).open).toBeGreaterThan(0);
    return (await get("/api/inbox")).items.find((i: any) => i.status === "open");
  };
  const resolve = (id: string, body: object) => post(`/api/inbox/${id}/resolve`, body);
  return { daemon, dir, repo, project, specs, post, get, startFeature, writeSpec, writeTicket, nextOpen, resolve, toolsOf };
}

describe("lead pipeline through the public API", () => {
  it("starts a lead agent that knows the feature's folder and has the planning tools", async () => {
    const { startFeature, specs, get } = await boot();
    const f = await startFeature("Add dark mode");
    expect(f.status).toBe(201);
    expect(f.json.stage).toBe("grill");
    expect(f.json.slug).toBe("add-dark-mode");
    const agents = await get("/api/agents");
    const lead = agents.find((a: any) => a.id === f.json.leadAgentId);
    expect(lead.lead).toBe(true);
    expect(specs.at(-1)!.task).toContain(".scratch/add-dark-mode/spec.md");
    const names = (await f.lead!.client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["ask_user", "submit_spec", "submit_tickets"]));
  });

  it("gives workers only the four ordinary tools", async () => {
    const { post, project, specs, writeTicket, toolsOf } = await boot();
    writeTicket("other", "01", "Plain ticket");
    await post("/api/agents", { projectId: project.id, name: "W", ticket: "other/01" });
    const { client } = await toolsOf(specs.at(-1)!);
    expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual(["ask_user", "get_my_ticket", "request_access", "set_my_status"]);
  });

  it("pauses at the spec gate, and a rejection sends the lead back to revise", async () => {
    const { startFeature, writeSpec, nextOpen, resolve, get } = await boot();
    const f = await startFeature();
    const slug = f.json.slug;
    const early = await f.lead!.call("submit_spec", { summary: "x" });
    expect(early.content[0]!.text).toMatch(/write the spec/i);

    writeSpec(slug);
    const pending = f.lead!.call("submit_spec", { summary: "Dark mode spec" });
    const item = await nextOpen();
    expect(item.kind).toBe("plan");
    expect(item.what).toMatch(/spec/i);
    expect((await get(`/api/features/${f.json.id}`)).stage).toBe("spec-gate");

    await resolve(item.id, { decision: "reply", text: "Cover the settings page too" });
    expect((await pending).content[0]!.text).toContain("Cover the settings page too");
    expect((await get(`/api/features/${f.json.id}`)).stage).toBe("grill");

    const again = f.lead!.call("submit_spec", { summary: "Revised" });
    await expect.poll(async () => (await get("/api/inbox")).open).toBe(1);
    const second = (await get("/api/inbox")).items.find((i: any) => i.status === "open");
    await resolve(second.id, { decision: "approve" });
    expect((await again).content[0]!.text).toMatch(/approved/i);
    expect((await get(`/api/features/${f.json.id}`)).stage).toBe("tickets");
  });

  it("refuses to submit tickets before the spec is approved", async () => {
    const { startFeature, writeTicket } = await boot();
    const f = await startFeature();
    writeTicket(f.json.slug, "01", "First");
    const r = await f.lead!.call("submit_tickets", { workers: 2 });
    expect(r.content[0]!.text).toMatch(/spec.*approved/i);
  });

  it("builds nothing until both gates are approved", async () => {
    const { startFeature, writeSpec, writeTicket, nextOpen, resolve, post, project, get, specs } = await boot();
    const f = await startFeature();
    const slug = f.json.slug;
    const ticket = `${slug}/01`;
    writeSpec(slug);
    writeTicket(slug, "01", "First");
    const startWorker = () => post("/api/agents", { projectId: project.id, name: "W", ticket });
    const workersStarted = () => specs.filter((s) => s.task?.includes("Work on ticket")).length;

    // Grill stage.
    expect((await startWorker()).status).toBe(409);

    // Spec gate pending.
    const spec = f.lead!.call("submit_spec", { summary: "s" });
    const specItem = await nextOpen();
    expect((await startWorker()).status).toBe(409);
    await resolve(specItem.id, { decision: "approve" });
    await spec;

    // Tickets stage and tickets gate pending: the spec is approved but the tickets are not.
    expect((await startWorker()).status).toBe(409);
    const tickets = f.lead!.call("submit_tickets", { workers: 2 });
    await expect.poll(async () => (await get("/api/inbox")).items.filter((i: any) => i.status === "open").length).toBe(1);
    const ticketItem = (await get("/api/inbox")).items.find((i: any) => i.status === "open");
    expect(ticketItem.kind).toBe("plan");
    expect((await startWorker()).status).toBe(409);
    expect(workersStarted()).toBe(0);

    await resolve(ticketItem.id, { decision: "approve" });
    await tickets;
    expect((await get(`/api/features/${f.json.id}`)).stage).toBe("build");
    expect((await startWorker()).status).toBe(201);
    expect(workersStarted()).toBe(1);
  });

  it("does not start queued tickets of an unapproved feature", async () => {
    const { startFeature, writeTicket, get, specs } = await boot();
    const f = await startFeature();
    writeTicket(f.json.slug, "01", "First");
    await new Promise((r) => setTimeout(r, 150));
    await get("/api/limits");
    expect(specs.filter((s) => s.task?.includes("Work on ticket"))).toHaveLength(0);
  });

  it("does not auto-start a ticket held by an unapproved feature gate", async () => {
    const { startFeature, writeTicket, post, project, specs } = await boot();
    const f = await startFeature();
    writeTicket(f.json.slug, "01", "First"); // written during the grill stage: not yet gated through
    await post(`/api/projects/${project.id}/auto-dispatch`, { on: true });
    expect(specs.filter((s) => s.task?.includes("Work on ticket"))).toHaveLength(0);
  });

  it("records the suggested worker count and the shape and colour the lead picked for each agent", async () => {
    const { startFeature, writeSpec, writeTicket, nextOpen, resolve, post, project, get, specs } = await boot();
    const f = await startFeature();
    const slug = f.json.slug;
    writeSpec(slug);
    writeTicket(slug, "01", "First");
    writeTicket(slug, "02", "Second", "01");
    const spec = f.lead!.call("submit_spec", { summary: "s" });
    await resolve((await nextOpen()).id, { decision: "approve" });
    await spec;

    const bad = await f.lead!.call("submit_tickets", { workers: 2, agents: [{ ticket: "01", shape: "blob", color: "#112233" }] });
    expect(bad.content[0]!.text).toMatch(/shape/i);
    const badColor = await f.lead!.call("submit_tickets", { workers: 2, agents: [{ ticket: "01", shape: "cloud", color: "red" }] });
    expect(badColor.content[0]!.text).toMatch(/colou?r/i);

    const submitted = f.lead!.call("submit_tickets", {
      workers: 2,
      agents: [{ ticket: "01", shape: "cloud", color: "#112233" }, { ticket: "02", shape: "pill", color: "#445566" }],
    });
    await expect.poll(async () => (await get("/api/inbox")).open).toBe(1);
    await resolve((await get("/api/inbox")).items.find((i: any) => i.status === "open").id, { decision: "approve" });
    await submitted;

    const view = await get(`/api/features/${f.json.id}`);
    expect(view.suggestedWorkers).toBe(2);
    expect(view.tickets.map((t: any) => [t.key, t.shape, t.color])).toEqual([["01", "cloud", "#112233"], ["02", "pill", "#445566"]]);

    await post("/api/agents", { projectId: project.id, name: "W1", ticket: `${slug}/01` });
    const worker = (await get("/api/agents")).find((a: any) => a.name === "W1");
    expect([worker.shape, worker.color]).toEqual(["cloud", "#112233"]);
    expect(specs.at(-1)!.task).toContain("Work on ticket");
  });

  it("serves the Plan view: spec text, tickets with blockers, and the three gates", async () => {
    const { startFeature, writeSpec, writeTicket, nextOpen, resolve, get, project } = await boot();
    const f = await startFeature();
    const slug = f.json.slug;
    expect((await get(`/api/features/${f.json.id}`)).gates).toEqual({ spec: "waiting", tickets: "waiting", merge: "waiting" });
    writeSpec(slug);
    writeTicket(slug, "01", "First");
    writeTicket(slug, "02", "Second", "01");

    const spec = f.lead!.call("submit_spec", { summary: "s" });
    await expect.poll(async () => (await get(`/api/features/${f.json.id}`)).gates.spec).toBe("pending");
    await resolve((await nextOpen()).id, { decision: "approve" });
    await spec;

    const view = await get(`/api/features/${f.json.id}`);
    expect(view.spec).toContain("Users can switch theme.");
    expect(view.gates).toEqual({ spec: "approved", tickets: "waiting", merge: "waiting" });
    const second = view.tickets.find((t: any) => t.key === "02");
    expect(second.blockers.map((b: any) => b.key)).toEqual(["01"]);

    const list = await get(`/api/projects/${project.id}/features`);
    expect(list.map((x: any) => x.id)).toEqual([f.json.id]);
  });

  it("keeps the feature and its gates after a restart", async () => {
    const first = await boot();
    const f = await first.startFeature();
    first.writeSpec(f.json.slug);
    const spec = f.lead!.call("submit_spec", { summary: "s" });
    const item = await first.nextOpen();
    void spec.catch(() => {});
    await first.daemon.close();

    const second = await boot({ dir: first.dir });
    expect((await second.get(`/api/features/${f.json.id}`)).stage).toBe("spec-gate");
    // The pending Inbox item still decides the gate, even though the lead's call was lost.
    await second.resolve(item.id, { decision: "approve" });
    expect((await second.get(`/api/features/${f.json.id}`)).stage).toBe("tickets");
  });

  it("rejects an empty description and an unknown project", async () => {
    const { post, project } = await boot();
    expect((await post(`/api/projects/${project.id}/features`, { description: "  " })).status).toBe(400);
    expect((await post(`/api/projects/nope/features`, { description: "x" })).status).toBe(404);
  });
});

describe("retro after a feature", () => {
  /** Takes a feature through both gates, then offers a way to move its single ticket to Done. */
  async function finish(b: Awaited<ReturnType<typeof boot>>) {
    const f = await b.startFeature();
    const slug = f.json.slug;
    b.writeSpec(slug);
    b.writeTicket(slug, "01", "First");
    const spec = f.lead!.call("submit_spec", { summary: "s" });
    await b.resolve((await b.nextOpen()).id, { decision: "approve" });
    await spec;
    const tickets = f.lead!.call("submit_tickets", { workers: 1 });
    await expect.poll(async () => (await b.get("/api/inbox")).items.filter((i: any) => i.status === "open").length).toBe(1);
    await b.resolve((await b.get("/api/inbox")).items.find((i: any) => i.status === "open").id, { decision: "approve" });
    await tickets;
    const move = async () => {
      const all = await b.get(`/api/projects/${b.project.id}/tickets`);
      await b.post(`/api/projects/${b.project.id}/tickets/status`, { ticket: all[0].id, column: "done" });
    };
    const retroItems = async () => (await b.get("/api/inbox")).items.filter((i: any) => i.kind === "retro");
    return { slug, move, retroItems };
  }

  it("is offered once when every ticket is done, and approving starts a retro agent", async () => {
    const b = await boot();
    const { slug, move, retroItems } = await finish(b);
    expect(await retroItems()).toHaveLength(0);
    await move();
    await expect.poll(async () => (await retroItems()).length).toBe(1);
    const item = (await retroItems())[0];
    expect(item.what).toMatch(/retro/i);
    await move();
    expect(await retroItems()).toHaveLength(1);
    const before = b.specs.length;
    await b.resolve(item.id, { decision: "approve" });
    await expect.poll(() => b.specs.length).toBe(before + 1);
    expect(b.specs.at(-1)!.task).toContain("mattpocock-skills:retro");
    expect(b.specs.at(-1)!.task).toContain(slug);
    expect((await b.get("/api/agents")).filter((a: any) => a.name === "Retro")).toHaveLength(1);
  });

  it("does not offer a retro for a feature that finished before retros existed", async () => {
    const b = await boot();
    const { slug } = await finish(b);
    // Finish the ticket on disk while Bridge is stopped, and make the next launch look like the first one after an upgrade.
    await b.daemon.close();
    const file = join(b.repo, ".scratch", slug, "issues", "01-first.md");
    writeFileSync(file, readFileSync(file, "utf8").replace("ready-for-agent", "done"));
    const store = openStore(join(b.dir, "data"));
    store.deleteSetting("retroBackfillDone");
    store.close();
    const again = await boot({ dir: b.dir });
    await again.get("/api/limits");
    await new Promise((r) => setTimeout(r, 300));
    expect((await again.get(`/api/projects/${again.project.id}/features`))[0].gates.merge).toBe("approved");
    expect((await again.get("/api/inbox")).items.filter((i: any) => i.kind === "retro")).toHaveLength(0);
  });

  it("starts nothing when the offer is declined", async () => {
    const b = await boot();
    const { move, retroItems } = await finish(b);
    await move();
    await expect.poll(async () => (await retroItems()).length).toBe(1);
    const before = b.specs.length;
    await b.resolve((await retroItems())[0].id, { decision: "deny" });
    expect(b.specs.length).toBe(before);
  });
});
