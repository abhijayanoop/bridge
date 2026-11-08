import { nodeCommandRunner, type CommandRunner } from "./sbx.ts";

export const AXES = ["standards", "spec"] as const;
export const SEVERITIES = ["high", "medium", "low"] as const;

export interface Finding {
  /** Standards: does the code follow the repo's conventions. Spec: does it do what the ticket asked. */
  axis: (typeof AXES)[number];
  severity: (typeof SEVERITIES)[number];
  summary: string;
  file?: string;
  line?: number;
}

export interface ReviewRequest {
  /** The branch's working directory (the agent's clone), with the branch checked out. */
  cwd: string;
  branch: string;
  /** The commit the branch started from: the review covers the changes since it. */
  base: string;
  /** Path of the ticket file in the repo: the spec the change is judged against. */
  ticketFile: string;
}

export type ReviewResult = { ok: true; findings: Finding[] } | { ok: false; reason: string };

/** Reviews a finished branch for standards and spec. Bridge runs the installed skill; it does not reimplement it. */
export interface Reviewer {
  review(request: ReviewRequest): Promise<ReviewResult>;
}

/** What the review may do: read the code and the git history, nothing that changes anything. */
const READ_ONLY_TOOLS = ["Read", "Grep", "Glob", "Agent", "Bash(git diff:*)", "Bash(git log:*)", "Bash(git show:*)", "Bash(git status:*)", "Bash(git rev-parse:*)"];
const REVIEW_TIMEOUT_MS = 20 * 60_000;

export function reviewPrompt(req: ReviewRequest): string {
  return [
    `Use the code-review skill (mattpocock-skills:code-review) to review this branch, ${req.branch}, against the fixed point ${req.base}.`,
    `The spec is the ticket file ${req.ticketFile}. Do not change any files.`,
    `When the review is done, reply with ONLY a JSON object, no other text, in this shape:`,
    `{"findings":[{"axis":"standards"|"spec","severity":"high"|"medium"|"low","summary":"one sentence","file":"path (optional)","line":123 (optional)}]}.`,
    `Use axis "standards" for coding-standard findings and "spec" for findings about what the ticket asked. high = must fix before merging, medium = should fix, low = a note. An empty findings array means the review is clean.`,
  ].join(" ");
}

/** Pulls the findings out of the model's reply, which may wrap the JSON in a code fence or a sentence. Null if there is none. */
export function parseFindings(text: string): Finding[] | null {
  const candidates: string[] = [text.trim()];
  for (const m of text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)) candidates.push(m[1]!.trim());
  const first = text.indexOf("{"), last = text.lastIndexOf("}");
  if (first !== -1 && last > first) candidates.push(text.slice(first, last + 1));
  for (const candidate of candidates.reverse()) {
    let parsed: unknown;
    try { parsed = JSON.parse(candidate); } catch { continue; }
    const list = (parsed as { findings?: unknown })?.findings;
    if (!Array.isArray(list)) continue;
    const findings: Finding[] = [];
    for (const raw of list as Record<string, unknown>[]) {
      if (!raw || !(AXES as readonly unknown[]).includes(raw.axis) || !(SEVERITIES as readonly unknown[]).includes(raw.severity)) continue;
      if (typeof raw.summary !== "string" || !raw.summary.trim()) continue;
      findings.push({
        axis: raw.axis as Finding["axis"], severity: raw.severity as Finding["severity"], summary: raw.summary.trim(),
        ...(typeof raw.file === "string" && raw.file ? { file: raw.file } : {}),
        ...(typeof raw.line === "number" && Number.isFinite(raw.line) ? { line: raw.line } : {}),
      });
    }
    return findings;
  }
  return null;
}

/**
 * Real reviewer: runs the user's installed code-review skill through the Claude CLI, headless, in the branch's
 * clone, on the host with the user's own login. Read-only tools only. Verified by the manual check in
 * docs/manual-check-real-cli.md, not by the default test run.
 */
export function createClaudeReviewer(run: CommandRunner = nodeCommandRunner, claude = "claude"): Reviewer {
  return {
    async review(req) {
      const r = await run(claude, ["-p", reviewPrompt(req), "--allowedTools", ...READ_ONLY_TOOLS], { cwd: req.cwd, timeoutMs: REVIEW_TIMEOUT_MS });
      if (r.code !== 0) {
        const why = (r.stderr.trim() || r.stdout.trim()).split(/\r?\n/).filter(Boolean).at(-1);
        return { ok: false, reason: `the claude CLI exited with ${r.code}${why ? `: ${why}` : ""}` };
      }
      const findings = parseFindings(r.stdout);
      return findings ? { ok: true, findings } : { ok: false, reason: "the review did not return findings in the expected JSON shape" };
    },
  };
}
