import { nodeCommandRunner, type CommandRunner } from "./sbx.ts";

export type PullResult =
  | { ok: true; url: string; number: number; existing?: boolean }
  /** `skipped` means there is nothing to do (no GitHub remote), as opposed to a failure. */
  | { ok: false; reason: string; skipped?: boolean };

/** Opens pull requests. Bridge only ever opens them; merging is for the user. */
export interface GitHub {
  createPullRequest(input: { repoPath: string; branch: string; title: string; body: string }): Promise<PullResult>;
}

const oneLine = (s: string) => s.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "";

/**
 * Real adapter over `git` and the GitHub CLI, running on the host with the user's own login: the sandbox never
 * holds GitHub credentials. Pushes only the ticket branch (never the default branch, never forced).
 */
export function createGitHubCli(run: CommandRunner = nodeCommandRunner, gh = "gh"): GitHub {
  return {
    async createPullRequest({ repoPath, branch, title, body }) {
      const cwd = { cwd: repoPath };
      const origin = await run("git", ["remote", "get-url", "origin"], cwd);
      if (origin.code !== 0) return { ok: false, skipped: true, reason: "this repo has no GitHub remote, so no pull request was opened" };

      const repo = await run(gh, ["repo", "view", "--json", "defaultBranchRef", "-q", ".defaultBranchRef.name"], cwd);
      const base = repo.code === 0 && oneLine(repo.stdout) ? oneLine(repo.stdout) : "main";
      if (!branch || branch === base) return { ok: false, reason: `refusing to open a pull request from ${branch || "no branch"}` };

      const existing = await run(gh, ["pr", "view", branch, "--json", "url,number"], cwd);
      if (existing.code === 0) {
        try {
          const pr = JSON.parse(existing.stdout) as { url: string; number: number };
          if (pr.url) return { ok: true, url: pr.url, number: pr.number, existing: true };
        } catch { /* fall through and create */ }
      }

      const push = await run("git", ["push", "origin", `refs/heads/${branch}:refs/heads/${branch}`], cwd);
      if (push.code !== 0) return { ok: false, reason: `git push failed: ${oneLine(push.stderr) || `exit ${push.code}`}` };

      const created = await run(gh, ["pr", "create", "--head", branch, "--base", base, "--title", title, "--body", body], cwd);
      const url = oneLine(created.stdout);
      const number = Number(url.match(/\/pull\/(\d+)/)?.[1]);
      if (created.code !== 0 || !number) return { ok: false, reason: `gh pr create failed: ${oneLine(created.stderr) || oneLine(created.stdout) || `exit ${created.code}`}` };
      return { ok: true, url, number };
    },
  };
}
