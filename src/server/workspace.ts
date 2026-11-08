import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

export type Mode = "local" | "sandbox";
export interface SkillSource { name: string; dir: string }
export interface Workspace { path: string; branch: string; env: Record<string, string> }

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

const isGitRepo = (dir: string) => existsSync(join(dir, ".git"));

/** `.env`, `.env.local`, `prod.env` ... but not templates such as `.env.example`. */
const isRealEnvFile = (name: string) =>
  (/^\.env(\..+)?$/i.test(name) || /\.env$/i.test(name)) && !/\.(example|sample|template|dist)$/i.test(name);

/** Branch name from the ticket file name, e.g. `ticket/08-clone-branch-local-mode`. */
export function branchFor(ticketFile: string, key: string): string {
  const slug = basename(ticketFile).replace(/\.md$/i, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return `ticket/${slug || key}`;
}

/** Names a template must never override: they would break the agent process itself. */
const RESERVED = /^(PATH|PATHEXT|HOME|USERPROFILE|SHELL|COMSPEC|TEMP|TMP|TMPDIR|NODE_OPTIONS|ANTHROPIC_.*|CLAUDE_.*)$/i;

/** Variable names from a template file. Real env files are never read. */
function templateKeys(dir: string): string[] {
  for (const name of [".env.example", ".env.sample", ".env.template"]) {
    const file = join(dir, name);
    if (!existsSync(file)) continue;
    const keys = readFileSync(file, "utf8").split(/\r?\n/)
      .map((l) => l.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/)?.[1])
      .filter((k): k is string => !!k && !RESERVED.test(k));
    if (keys.length) return keys;
  }
  return [];
}

/** Removes env files from a fresh clone and hides the removal from git. */
function stripEnvFiles(root: string) {
  const walk = (dir: string, rel: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === ".git") continue;
      const abs = join(dir, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { walk(abs, r); continue; }
      if (!isRealEnvFile(e.name)) continue;
      rmSync(abs, { force: true });
      try { git(root, "update-index", "--skip-worktree", "--", r); } catch { /* untracked */ }
    }
  };
  walk(root, "");
}

/** Creates one fresh clone per ticket on its own branch; the user's working copy is never touched. */
export function createWorkspaces(opts: { clonesDir: string; skills?: SkillSource[] }) {
  return {
    /** Removes an agent's clone. Only ever touches `<clonesDir>/<agentId>`. */
    remove(agentId: string) {
      if (!/^[\w-]+$/.test(agentId)) return;
      rmSync(join(opts.clonesDir, agentId), { recursive: true, force: true });
    },
    /**
     * Fetches an agent's branch from its clone into the user's repo as a local branch of the same name, so
     * the work is reviewable (`git log <branch>`) and survives deleting the agent. Never touches the working
     * tree; a branch that already diverged is left alone. Returns the branch, or null if there was nothing to fetch.
     */
    publish(agentId: string, projectPath: string, branch?: string): string | null {

      if (!/^[\w-]+$/.test(agentId)) return null;
      const clone = join(opts.clonesDir, agentId);
      if (!isGitRepo(clone) || !isGitRepo(projectPath)) return null;
      try {
        const name = branch ?? git(clone, "rev-parse", "--abbrev-ref", "HEAD");
        if (!name || name === "HEAD") return null;
        git(clone, "rev-parse", "--verify", "--quiet", `refs/heads/${name}`);
        const fetchAs = (target: string) => git(projectPath, "fetch", "--quiet", clone, `refs/heads/${name}:refs/heads/${target}`);
        try { fetchAs(name); return name; } catch (err) {
          // A branch of that name already exists and has diverged (an earlier run of the same ticket): keep it, use a unique name.
          const alt = `${name}-${agentId.slice(0, 8)}`;
          try { fetchAs(alt); return alt; } catch { throw err; }
        }
      } catch { return null; }
    },
    /** Contents of a file on a branch of the user's repo, or "" if it is not there. */
    fileAt(projectPath: string, branch: string, file: string): string {
      try { return execFileSync("git", ["show", `${branch}:${file}`], { cwd: projectPath, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }); } catch { return ""; }
    },
    /**
     * Merges a ticket branch into the branch the user has checked out (no fast-forward, so the merge shows in history).
     * Refuses when tracked files have uncommitted changes, except Bridge's own bookkeeping: a `Status:` line in a
     * ticket file under `.scratch/`, which is put back first (the caller re-applies it). A conflict is aborted.
     */
    mergeLocal(projectPath: string, branch: string, message: string): { ok: true } | { ok: false; reason: string } {
      const fail = (reason: string) => ({ ok: false as const, reason });
      if (!isGitRepo(projectPath)) return fail("this project is not a git repository");
      let current: string;
      try { current = git(projectPath, "symbolic-ref", "--short", "HEAD"); } catch { return fail("your working copy is on a detached HEAD; check out a branch first"); }
      if (current === branch) return fail(`${branch} is the branch you have checked out`);
      try { git(projectPath, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`); } catch { return fail(`branch ${branch} is not in your repo`); }

      const dirty = git(projectPath, "diff", "--name-only", "HEAD").split(/\r?\n/).filter(Boolean);
      const bookkeeping: string[] = [];
      for (const file of dirty) {
        const changed = file.startsWith(".scratch/")
          ? git(projectPath, "diff", "-U0", "HEAD", "--", file).split(/\r?\n/).filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---)/.test(l))
          : ["x"];
        if (changed.length && changed.every((l) => /^[+-](\*\*)?Status:/i.test(l))) bookkeeping.push(file);
        else return fail(`you have uncommitted changes in ${file}; commit or stash them before merging`);
      }
      if (bookkeeping.length) git(projectPath, "checkout", "HEAD", "--", ...bookkeeping);

      let who: string[] = [];
      try { git(projectPath, "config", "user.email"); } catch { who = ["-c", "user.name=Bridge", "-c", "user.email=bridge@localhost"]; }
      try {
        git(projectPath, ...who, "merge", "--no-ff", "-m", `Merge ${message}`, branch);
        return { ok: true };
      } catch (err) {
        try { git(projectPath, "merge", "--abort"); } catch { /* nothing to abort */ }
        const detail = String((err as { stdout?: string }).stdout ?? "").split(/\r?\n/).find((l) => /conflict/i.test(l));
        return fail(`merging ${branch} hit a conflict${detail ? ` (${detail.trim()})` : ""}; it was undone, resolve it in your repo`);
      }
    },
    /** Returns null when the project is not a git repository (the agent then works in place). */
    prepare(input: { agentId: string; projectPath: string; ticketFile: string; ticketKey: string }): Workspace | null {
      if (!isGitRepo(input.projectPath)) return null;
      const dest = join(opts.clonesDir, input.agentId);
      mkdirSync(opts.clonesDir, { recursive: true });
      const branch = branchFor(input.ticketFile, input.ticketKey);
      try {
        git(opts.clonesDir, "clone", "--quiet", "--no-hardlinks", input.projectPath, dest);
        let origin = "";
        try { origin = git(input.projectPath, "remote", "get-url", "origin"); } catch { /* local-only repo */ }
        if (origin) git(dest, "remote", "set-url", "origin", origin);
        else git(dest, "remote", "remove", "origin");
        git(dest, "checkout", "--quiet", "-b", branch);
        stripEnvFiles(dest);
      } catch (err) {
        rmSync(dest, { recursive: true, force: true });
        throw err;
      }
      appendFileSync(join(dest, ".git", "info", "exclude"), "\n.env\n.claude/\n");
      // A ticket that is not committed yet is missing from the clone; copy it so the agent can read it.
      const ticketRel = input.ticketFile.replace(/\\/g, "/");
      if (!existsSync(join(dest, ticketRel)) && existsSync(join(input.projectPath, ticketRel))) {
        try {
          mkdirSync(dirname(join(dest, ticketRel)), { recursive: true });
          cpSync(join(input.projectPath, ticketRel), join(dest, ticketRel));
          appendFileSync(join(dest, ".git", "info", "exclude"), `${ticketRel}\n`);
        } catch { /* agent falls back to the Bridge ticket tool */ }
      }
      const env: Record<string, string> = {};
      for (const key of templateKeys(dest)) env[key] = `throwaway-${randomBytes(9).toString("hex")}`;
      if (Object.keys(env).length) writeFileSync(join(dest, ".env"), Object.entries(env).map(([k, v]) => `${k}=${v}`).join("\n") + "\n");
      for (const skill of opts.skills ?? []) {
        try { cpSync(skill.dir, join(dest, ".claude", "skills", skill.name), { recursive: true }); } catch { /* skill vanished */ }
      }
      return { path: dest, branch, env };
    },
  };
}

/** Finds the installed Pocock skills (latest version of the plugin) as `{ name, dir }`. */
export function discoverPocockSkills(home = homedir()): SkillSource[] {
  const base = join(home, ".claude", "plugins", "cache");
  const out: SkillSource[] = [];
  try {
    for (const marketplace of readdirSync(base)) {
      const plugin = join(base, marketplace, "mattpocock-skills");
      if (!existsSync(plugin)) continue;
      const version = readdirSync(plugin).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).at(-1);
      if (!version) continue;
      const skills = join(plugin, version, "skills");
      for (const category of readdirSync(skills)) {
        if (category === "deprecated") continue;
        for (const name of readdirSync(join(skills, category))) {
          const dir = join(skills, category, name);
          if (existsSync(join(dir, "SKILL.md"))) out.push({ name, dir });
        }
      }
    }
  } catch { /* not installed */ }
  return out;
}
