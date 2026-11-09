import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { startDaemon } from "../src/server/daemon.ts";
import { createFakeAgentRunner } from "../src/server/fake-agent.ts";
import type { GitHub } from "../src/server/github.ts";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), "bridge-first-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};
async function boot(dataDir = tmp(), github?: Partial<GitHub>) {
  const daemon = await startDaemon({ dataDir, runner: createFakeAgentRunner([]), github: github as GitHub | undefined });
  let closed = false;
  const close = async () => { if (!closed) { closed = true; await daemon.close(); } };
  cleanups.push(close);
  return { url: daemon.url, close, dataDir };
}
const call = (url: string, body?: unknown) =>
  fetch(url, body === undefined ? undefined : { method: "POST", body: JSON.stringify(body) })
    .then(async (r) => ({ status: r.status, json: (await r.json()) as any }));
const repo = (name: string) => { const d = join(tmp(), name); mkdirSync(join(d, ".git"), { recursive: true }); return d; };

describe("first-run setup", () => {
  it("a fresh repo needs setup; running it writes the tracker, labels and docs layout, and later opens skip it", async () => {
    const d = await boot();
    const dir = repo("fresh");
    const p = (await call(`${d.url}/api/projects/open`, { path: dir })).json;
    expect((await call(`${d.url}/api/projects/${p.id}/setup`)).json).toMatchObject({ needed: true });

    const done = await call(`${d.url}/api/projects/${p.id}/setup`, { tracker: "local" });
    expect(done.status).toBe(200);
    expect(done.json.needed).toBe(false);
    expect(readFileSync(join(dir, "docs/agents/issue-tracker.md"), "utf8")).toContain(".scratch/");
    expect(readFileSync(join(dir, "docs/agents/triage-labels.md"), "utf8")).toContain("ready-for-agent");
    expect(existsSync(join(dir, "docs/agents/domain.md"))).toBe(true);
    expect(readFileSync(join(dir, "CLAUDE.md"), "utf8")).toContain("## Agent skills");

    // Survives a restart and a reopen of the same repo.
    await d.close();
    const d2 = await boot(d.dataDir);
    const again = (await call(`${d2.url}/api/projects/open`, { path: dir })).json;
    expect((await call(`${d2.url}/api/projects/${again.id}/setup`)).json.needed).toBe(false);
  });

  it("keeps existing CLAUDE.md content, custom labels, and the GitHub tracker choice", async () => {
    const d = await boot();
    const dir = repo("existing");
    writeFileSync(join(dir, "CLAUDE.md"), "# Mine\n\nKeep me.\n");
    const p = (await call(`${d.url}/api/projects/open`, { path: dir })).json;
    await call(`${d.url}/api/projects/${p.id}/setup`, { tracker: "github", labels: { "needs-triage": "triage" } });
    const claude = readFileSync(join(dir, "CLAUDE.md"), "utf8");
    expect(claude).toContain("Keep me.");
    expect(claude).toContain("GitHub");
    expect(readFileSync(join(dir, "docs/agents/triage-labels.md"), "utf8")).toMatch(/`needs-triage`\s*\|\s*`triage`/);
  });

  it("a repo already configured for the skills is not asked again", async () => {
    const d = await boot();
    const dir = repo("configured");
    mkdirSync(join(dir, "docs/agents"), { recursive: true });
    writeFileSync(join(dir, "docs/agents/issue-tracker.md"), "# x");
    const p = (await call(`${d.url}/api/projects/open`, { path: dir })).json;
    expect((await call(`${d.url}/api/projects/${p.id}/setup`)).json.needed).toBe(false);
  });

  it("rejects an unknown tracker and an unknown project", async () => {
    const d = await boot();
    const p = (await call(`${d.url}/api/projects/open`, { path: repo("x") })).json;
    expect((await call(`${d.url}/api/projects/${p.id}/setup`, { tracker: "jira" })).status).toBe(400);
    expect((await call(`${d.url}/api/projects/nope/setup`)).status).toBe(404);
  });
});

describe("new project", () => {
  it("shows the plan and writes nothing until approved", async () => {
    const d = await boot();
    const parent = tmp();
    const preview = await call(`${d.url}/api/projects/new`, { name: "shiny", parent });
    expect(preview.status).toBe(200);
    expect(preview.json).toMatchObject({ approved: false, path: join(parent, "shiny") });
    expect(preview.json.steps.length).toBeGreaterThan(2);
    expect(existsSync(join(parent, "shiny"))).toBe(false);
    expect((await call(`${d.url}/api/projects`)).json).toHaveLength(0);
  });

  it("after approval scaffolds a git repo with the skills layout, registers and selects it", async () => {
    const d = await boot();
    const parent = tmp();
    const r = await call(`${d.url}/api/projects/new`, { name: "shiny", parent, approved: true });
    expect(r.status).toBe(201);
    const dir = join(parent, "shiny");
    expect(r.json.project).toMatchObject({ name: "shiny", path: dir });
    expect(execFileSync("git", ["log", "--oneline"], { cwd: dir, encoding: "utf8" })).toContain("Initial");
    expect(existsSync(join(dir, "README.md"))).toBe(true);
    expect(existsSync(join(dir, ".scratch"))).toBe(true);
    expect(existsSync(join(dir, "docs/agents/issue-tracker.md"))).toBe(true);
    expect((await call(`${d.url}/api/active-project`)).json.id).toBe(r.json.project.id);
    expect((await call(`${d.url}/api/projects/${r.json.project.id}/setup`)).json.needed).toBe(false);
  });

  it("can create the GitHub repo too, and keeps the local repo if GitHub fails", async () => {
    const calls: any[] = [];
    const d = await boot(undefined, { createRepository: async (c) => { calls.push(c); return { ok: true, url: "https://github.com/me/shiny" }; } });
    const parent = tmp();
    const ok = await call(`${d.url}/api/projects/new`, { name: "shiny", parent, github: true, approved: true });
    expect(ok.json.github).toEqual({ ok: true, url: "https://github.com/me/shiny" });
    expect(calls[0]).toMatchObject({ repoPath: join(parent, "shiny"), name: "shiny", private: true });

    const d2 = await boot(undefined, { createRepository: async () => ({ ok: false, reason: "not logged in" }) });
    const bad = await call(`${d2.url}/api/projects/new`, { name: "other", parent, github: true, approved: true });
    expect(bad.status).toBe(201);
    expect(bad.json.github).toMatchObject({ ok: false, reason: "not logged in" });
    expect(existsSync(join(parent, "other", ".git"))).toBe(true);
  });

  it("refuses bad names, missing parents and non-empty targets", async () => {
    const d = await boot();
    const parent = tmp();
    for (const name of ["", "a/b", "..", "a\b"]) expect((await call(`${d.url}/api/projects/new`, { name, parent, approved: true })).status).toBe(400);
    expect((await call(`${d.url}/api/projects/new`, { name: "x", parent: join(parent, "nope"), approved: true })).status).toBe(400);
    mkdirSync(join(parent, "taken"));
    writeFileSync(join(parent, "taken", "f.txt"), "x");
    expect((await call(`${d.url}/api/projects/new`, { name: "taken", parent, approved: true })).status).toBe(409);
  });
});
