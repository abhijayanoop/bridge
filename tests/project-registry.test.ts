import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startDaemon } from "../src/server/daemon.ts";
import { createFakeAgentRunner } from "../src/server/fake-agent.ts";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

function tmp() {
  const dir = mkdtempSync(join(tmpdir(), "bridge-reg-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function repo(name: string) {
  const dir = join(tmp(), name);
  mkdirSync(join(dir, ".git"), { recursive: true });
  return dir;
}
async function boot(dataDir = tmp()) {
  const daemon = await startDaemon({ dataDir, runner: createFakeAgentRunner([]) });
  let closed = false;
  const close = async () => { if (!closed) { closed = true; await daemon.close(); } };
  cleanups.push(close);
  return { daemon: { url: daemon.url, close }, dataDir };
}
const call = (url: string, body?: unknown) =>
  fetch(url, body === undefined ? undefined : { method: "POST", body: JSON.stringify(body) })
    .then(async (r) => ({ status: r.status, json: (await r.json()) as any }));

describe("project registry via the public API", () => {
  it("opening a repo registers it, selects it and lists it; reopening is idempotent", async () => {
    const { daemon } = await boot();
    const a = repo("alpha");
    const first = await call(`${daemon.url}/api/projects/open`, { path: a });
    expect(first.status).toBe(201);
    expect(first.json).toMatchObject({ name: "alpha" });
    const again = await call(`${daemon.url}/api/projects/open`, { path: a });
    expect(again.status).toBe(200);
    expect(again.json.id).toBe(first.json.id);

    const list = (await call(`${daemon.url}/api/projects`)).json;
    expect(list).toHaveLength(1);
    expect((await call(`${daemon.url}/api/active-project`)).json.id).toBe(first.json.id);
  });

  it("rejects a path that is not a directory", async () => {
    const { daemon } = await boot();
    const r = await call(`${daemon.url}/api/projects/open`, { path: join(tmp(), "missing") });
    expect(r.status).toBe(400);
    expect((await call(`${daemon.url}/api/projects/open`, {})).status).toBe(400);
  });

  it("switches the active project and broadcasts it", async () => {
    const { daemon } = await boot();
    const a = (await call(`${daemon.url}/api/projects/open`, { path: repo("alpha") })).json;
    const b = (await call(`${daemon.url}/api/projects/open`, { path: repo("beta") })).json;
    expect((await call(`${daemon.url}/api/active-project`)).json.id).toBe(b.id);

    const ws = new WebSocket(daemon.url.replace("http", "ws") + "/ws");
    const received: any[] = [];
    await new Promise((r) => ws.addEventListener("open", r, { once: true }));
    ws.addEventListener("message", (m) => received.push(JSON.parse(String(m.data))));
    const sel = await call(`${daemon.url}/api/projects/${a.id}/select`, {});
    expect(sel.status).toBe(200);
    await expect.poll(() => received.some((m) => m.type === "active-project" && m.projectId === a.id)).toBe(true);
    ws.close();
    expect((await call(`${daemon.url}/api/active-project`)).json.id).toBe(a.id);
    expect((await call(`${daemon.url}/api/projects/nope/select`, {})).status).toBe(404);
  });

  it("persists projects and the active selection across restarts", async () => {
    const first = await boot();
    const a = (await call(`${first.daemon.url}/api/projects/open`, { path: repo("alpha") })).json;
    await call(`${first.daemon.url}/api/projects/open`, { path: repo("beta") });
    await call(`${first.daemon.url}/api/projects/${a.id}/select`, {});
    await first.daemon.close();

    const { daemon } = await boot(first.dataDir);
    expect(((await call(`${daemon.url}/api/projects`)).json as any[]).map((p) => p.name)).toEqual(["alpha", "beta"]);
    expect((await call(`${daemon.url}/api/active-project`)).json.id).toBe(a.id);
  });

  it("models many repos per workspace", async () => {
    const { daemon } = await boot();
    await call(`${daemon.url}/api/projects/open`, { path: repo("alpha") });
    await call(`${daemon.url}/api/projects/open`, { path: repo("beta") });
    const workspaces = (await call(`${daemon.url}/api/workspaces`)).json as any[];
    expect(workspaces).toHaveLength(1);
    expect(workspaces[0].repos.map((r: any) => r.name)).toEqual(["alpha", "beta"]);
  });

  it("records the ticket-to-repo relation: a ticket belongs to exactly one repo", async () => {
    const { daemon } = await boot();
    const a = (await call(`${daemon.url}/api/projects/open`, { path: repo("alpha") })).json;
    const ok = await call(`${daemon.url}/api/projects/${a.id}/tickets`, { key: "01", title: "First" });
    expect(ok.status).toBe(201);
    expect(ok.json).toMatchObject({ repoId: a.id, key: "01" });
    expect((await call(`${daemon.url}/api/projects/nope/tickets`, { key: "x", title: "y" })).status).toBe(404);
    const list = (await call(`${daemon.url}/api/projects/${a.id}/tickets`)).json as any[];
    expect(list.map((t) => t.key)).toEqual(["01"]);
  });
});
