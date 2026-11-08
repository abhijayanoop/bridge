import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startDaemon } from "../src/server/daemon.ts";
import { createFakeAgentRunner } from "../src/server/fake-agent.ts";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), "bridge-tix-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const post = (url: string, body: unknown) =>
  fetch(url, { method: "POST", body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, json: (await r.json()) as any }));

function ticketFile(repo: string, feature: string, name: string, text: string) {
  const dir = join(repo, ".scratch", feature, "issues");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), text);
  return join(dir, name);
}

async function setup() {
  const repo = join(tmp(), "alpha");
  mkdirSync(join(repo, ".git"), { recursive: true });
  const files = {
    one: ticketFile(repo, "app", "01-schema.md", "# 01: Schema\n\n**Blocked by:** none\n\n**Status:** done\n\n- [x] a\n"),
    two: ticketFile(repo, "app", "02-api.md", "# 02: API\n\n**Blocked by:** 01\n**Agent:** Ember\n**Status:** in-progress\n"),
    three: ticketFile(repo, "app", "03-ui.md", "# 03: UI\r\n\r\n**Blocked by:** 01, 02\r\n\r\n**Status:** ready-for-agent\r\n\r\n## Comments\r\nStatus: done\r\n"),
    plain: ticketFile(repo, "other", "01-x.md", "# 01: Plain\n\nStatus: in-review\nBlocked by: 9\n"),
  };
  const daemon = await startDaemon({ dataDir: tmp(), runner: createFakeAgentRunner([]) });
  cleanups.push(() => daemon.close());
  const project = (await post(`${daemon.url}/api/projects/open`, { path: repo })).json;
  const list = () => fetch(`${daemon.url}/api/projects/${project.id}/tickets`).then((r) => r.json() as Promise<any[]>);
  const move = (ticket: string, column: string) => post(`${daemon.url}/api/projects/${project.id}/tickets/status`, { ticket, column });
  return { daemon, project, repo, files, list, move };
}

describe("ticket store via the public API", () => {
  it("reads ticket files into tickets with id, title, agent, blockers and status columns", async () => {
    const { list, project } = await setup();
    const byId = Object.fromEntries((await list()).map((t) => [t.id, t]));
    expect(byId["app/01"]).toMatchObject({ title: "Schema", column: "done", blocked: false, repoId: project.id, agent: null, blockers: [] });
    expect(byId["app/02"]).toMatchObject({ title: "API", column: "in-progress", agent: "Ember", status: "in-progress" });
    expect(byId["app/03"]).toMatchObject({ title: "UI", column: "backlog", status: "ready-for-agent" });
    expect(byId["other/01"]).toMatchObject({ column: "review", file: ".scratch/other/issues/01-x.md" });
  });

  it("marks tickets blocked until every blocker is done", async () => {
    const { list, move } = await setup();
    const get = async (id: string) => (await list()).find((t) => t.id === id);
    const ui = await get("app/03");
    expect(ui.blocked).toBe(true);
    expect(ui.blockers.map((b: any) => [b.id, b.done])).toEqual([["app/01", true], ["app/02", false]]);
    expect((await get("other/01")).blocked).toBe(true); // unknown blocker never resolves
    await move("app/02", "done");
    expect((await get("app/03")).blocked).toBe(false);
    expect((await get("app/01")).blocked).toBe(false);
  });

  it("writes status changes back to the ticket file, keeping its layout", async () => {
    const { files, list, move } = await setup();
    const r = await move("app/03", "in-progress");
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ column: "in-progress", status: "in-progress" });
    const text = readFileSync(files.three, "utf8");
    expect(text).toContain("**Status:** in-progress\r\n");
    expect(text).toContain("## Comments\r\nStatus: done"); // body untouched
    expect(text).not.toMatch(/[^\r]\n/);
    await move("app/03", "review");
    expect(readFileSync(files.three, "utf8")).toContain("**Status:** in-review");
    await move("other/01", "backlog");
    expect(readFileSync(files.plain, "utf8")).toContain("\nStatus: ready-for-agent\n");
    expect((await list()).find((t) => t.id === "other/01").column).toBe("backlog");
  });

  it("keeps a triage label when the ticket is already in that column", async () => {
    const { files, move } = await setup();
    await move("app/03", "backlog");
    expect(readFileSync(files.three, "utf8")).toContain("**Status:** ready-for-agent");
  });

  it("adds a Status line to a file without one", async () => {
    const { repo, list, move } = await setup();
    const f = ticketFile(repo, "app", "04-bare.md", "# 04: Bare\n\n**Blocked by:** 01\n\nBody\n");
    await move("app/04", "review");
    expect(readFileSync(f, "utf8")).toBe("# 04: Bare\n\n**Blocked by:** 01\nStatus: in-review\n\nBody\n");
    expect((await list()).find((t) => t.id === "app/04").column).toBe("review");
  });

  it("rejects unknown projects, tickets and columns", async () => {
    const { daemon, project, move } = await setup();
    expect((await move("app/99", "done")).status).toBe(404);
    expect((await move("app/01", "nope")).status).toBe(400);
    expect((await post(`${daemon.url}/api/projects/nope/tickets/status`, { ticket: "app/01", column: "done" })).status).toBe(404);
    expect(project.id).toBeTruthy();
  });

  it("shows edits made directly in the file, on request and via a pushed event", async () => {
    const { daemon, files, list } = await setup();
    const ws = new WebSocket(daemon.url.replace("http", "ws") + "/ws");
    const received: any[] = [];
    await new Promise((r) => ws.addEventListener("open", r, { once: true }));
    ws.addEventListener("message", (m) => received.push(JSON.parse(String(m.data))));
    writeFileSync(files.two, "# 02: API renamed\n\n**Blocked by:** 01\n**Status:** in-review\n");
    await expect.poll(() => received.some((m) => m.type === "tickets")).toBe(true);
    ws.close();
    expect((await list()).find((t) => t.id === "app/02")).toMatchObject({ title: "API renamed", column: "review", agent: null });
  });

  it("returns no tickets for a repo without ticket files", async () => {
    const { daemon } = await setup();
    const bare = join(tmp(), "bare");
    mkdirSync(bare);
    const p = (await post(`${daemon.url}/api/projects/open`, { path: bare })).json;
    expect(await (await fetch(`${daemon.url}/api/projects/${p.id}/tickets`)).json()).toEqual([]);
  });
});
