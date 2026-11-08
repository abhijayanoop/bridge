import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startDaemon } from "../src/server/daemon.ts";
import { createFakeAgentRunner } from "../src/server/fake-agent.ts";
import type { AgentRunner, AgentSpec } from "../src/server/agent-runner.ts";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" }).trim();

const REAL_SECRET = "sk_live_REAL_SECRET_VALUE";

async function boot(opts: { skills?: boolean; committedEnv?: boolean; mode?: "local" | "sandbox" } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "bridge-clone-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const repo = join(dir, "repo");
  mkdirSync(join(repo, ".scratch", "f", "issues"), { recursive: true });
  writeFileSync(join(repo, ".scratch", "f", "issues", "01-add-thing.md"), "# 01: Add thing\n\n**Status:** ready-for-agent\n");
  writeFileSync(join(repo, "app.txt"), "hello\n");
  writeFileSync(join(repo, ".env.example"), "STRIPE_KEY=\nDATABASE_URL=\n# comment\n");
  writeFileSync(join(repo, ".gitignore"), ".env\n.env.*\n!.env.example\n");
  git(repo, "init", "-b", "main");
  if (opts.committedEnv) { writeFileSync(join(repo, ".env.production"), `STRIPE_KEY=${REAL_SECRET}\n`); git(repo, "add", "-f", ".env.production"); }
  git(repo, "add", "-A");
  git(repo, "commit", "-m", "init");
  // Real env files, untracked and ignored.
  writeFileSync(join(repo, ".env"), `STRIPE_KEY=${REAL_SECRET}\n`);
  mkdirSync(join(repo, "sub"));
  writeFileSync(join(repo, "sub", ".env.local"), `X=${REAL_SECRET}\n`);

  let skills: { name: string; dir: string }[] | undefined;
  if (opts.skills) {
    const sdir = join(dir, "skills", "tdd");
    mkdirSync(sdir, { recursive: true });
    writeFileSync(join(sdir, "SKILL.md"), "# tdd skill\n");
    skills = [{ name: "tdd", dir: sdir }];
  }
  const specs: AgentSpec[] = [];
  const fake = createFakeAgentRunner([]);
  const runner: AgentRunner = { ...fake, start(spec, emit) { specs.push(spec); fake.start(spec, emit); } };
  const daemon = await startDaemon({ dataDir: join(dir, "data"), runner, skills, mode: opts.mode });
  cleanups.push(() => daemon.close());
  const post = async (path: string, body: unknown) => {
    const r = await fetch(daemon.url + path, { method: "POST", body: JSON.stringify(body) });
    return { status: r.status, json: (await r.json()) as any };
  };
  const project = (await post("/api/projects", { name: "demo", path: repo })).json;
  const start = () => post("/api/agents", { projectId: project.id, name: "A", ticket: "f/01" });
  return { repo, start, specs, dir };
}

function allFiles(root: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(root, { withFileTypes: true })) {
    if (e.name === ".git") continue;
    const p = join(root, e.name);
    if (e.isDirectory()) out.push(...allFiles(p)); else out.push(p);
  }
  return out;
}

describe("clone, branch and local mode via the public API", () => {
  it("starting a ticket makes a fresh clone on its own branch and leaves the working copy alone", async () => {
    const { repo, start, specs } = await boot();
    writeFileSync(join(repo, "wip.txt"), "uncommitted\n");
    const beforeStatus = git(repo, "status", "--porcelain");
    const beforeHead = git(repo, "rev-parse", "HEAD");
    const res = await start();
    expect(res.status).toBe(201);
    const cwd = specs[0]!.cwd!;
    expect(cwd).not.toBe(repo);
    expect(existsSync(join(cwd, "app.txt"))).toBe(true);
    expect(git(cwd, "branch", "--show-current")).toBe("ticket/01-add-thing");
    expect(res.json.workspace.branch).toBe("ticket/01-add-thing");
    expect(git(repo, "status", "--porcelain")).toBe(beforeStatus);
    expect(git(repo, "rev-parse", "HEAD")).toBe(beforeHead);
    expect(git(repo, "branch", "--show-current")).toBe("main");
    expect(git(repo, "branch", "--list", "ticket/*")).toBe("");
    // Hooks and tools are wired into the clone, not the working copy.
    expect(existsSync(join(cwd, ".claude", "bridge-hook.mjs"))).toBe(true);
    expect(existsSync(join(repo, ".claude"))).toBe(false);
    // Every start is a fresh clone.
    await start();
    expect(specs[1]!.cwd).not.toBe(cwd);
  });

  it("never puts a real .env file in a clone, even a committed one", async () => {
    const { start, specs } = await boot({ committedEnv: true });
    await start();
    const cwd = specs[0]!.cwd!;
    for (const f of allFiles(cwd)) {
      expect(readFileSync(f, "utf8")).not.toContain(REAL_SECRET);
    }
    expect(existsSync(join(cwd, ".env.production"))).toBe(false);
    expect(existsSync(join(cwd, "sub", ".env.local"))).toBe(false);
    // Templates stay; a deleted tracked env file must not show up as a change to commit.
    expect(existsSync(join(cwd, ".env.example"))).toBe(true);
    expect(git(cwd, "status", "--porcelain")).toBe("");
  });

  it("generates throwaway env values from the template", async () => {
    const { start, specs } = await boot();
    await start();
    const cwd = specs[0]!.cwd!;
    const env = Object.fromEntries(readFileSync(join(cwd, ".env"), "utf8").split("\n").filter(Boolean).map((l) => l.split("=") as [string, string]));
    expect(Object.keys(env).sort()).toEqual(["DATABASE_URL", "STRIPE_KEY"]);
    expect(env.STRIPE_KEY).toMatch(/^throwaway-/);
    expect(specs[0]!.env?.STRIPE_KEY).toBe(env.STRIPE_KEY);
    await start();
    expect(readFileSync(join(specs[1]!.cwd!, ".env"), "utf8")).not.toBe(readFileSync(join(cwd, ".env"), "utf8"));
  });

  it("copies the installed Pocock skills into the clone", async () => {
    const { start, specs } = await boot({ skills: true });
    await start();
    const cwd = specs[0]!.cwd!;
    expect(readFileSync(join(cwd, ".claude", "skills", "tdd", "SKILL.md"), "utf8")).toBe("# tdd skill\n");
    expect(git(cwd, "status", "--porcelain")).toBe("");
  });

  it("local mode keeps permission prompts on; sandbox mode does not", async () => {
    const local = await boot();
    await local.start();
    expect(local.specs[0]!.mode).toBe("local");
    expect(local.specs[0]!.permissionPrompts).toBe(true);
    const sandbox = await boot({ mode: "sandbox" });
    await sandbox.start();
    expect(sandbox.specs[0]!.permissionPrompts).toBe(false);
  });

  it("uses the working copy's origin so pull requests can be opened", async () => {
    const { repo, start, specs } = await boot();
    git(repo, "remote", "add", "origin", "https://example.com/me/demo.git");
    await start();
    expect(git(specs[0]!.cwd!, "remote", "get-url", "origin")).toBe("https://example.com/me/demo.git");
  });
});
