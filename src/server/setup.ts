import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type Tracker = "local" | "github";
export const TRACKERS: readonly Tracker[] = ["local", "github"];
export const LABEL_ROLES = ["needs-triage", "needs-info", "ready-for-agent", "ready-for-human", "wontfix"] as const;
const MEANING: Record<string, string> = {
  "needs-triage": "Maintainer needs to evaluate this issue",
  "needs-info": "Waiting on reporter for more information",
  "ready-for-agent": "Fully specified, ready for an AFK agent",
  "ready-for-human": "Requires human implementation",
  "wontfix": "Will not be actioned",
};

/** True when the repo already has the skills' tracker doc, so Bridge must not ask again. */
export const isConfigured = (repo: string) => existsSync(join(repo, "docs", "agents", "issue-tracker.md"));

const LOCAL_TRACKER = `# Issue tracker: Local Markdown

Issues and specs for this repo live as markdown files in \`.scratch/\`.

## Conventions

- One feature per directory: \`.scratch/<feature-slug>/\`
- The spec is \`.scratch/<feature-slug>/spec.md\`
- Implementation issues are one file per ticket at \`.scratch/<feature-slug>/issues/<NN>-<slug>.md\`, numbered from \`01\`
- Triage state is a \`Status:\` line near the top of each issue file (see \`triage-labels.md\`)
- Comments append to the bottom of the file under a \`## Comments\` heading
`;
const GITHUB_TRACKER = `# Issue tracker: GitHub

Issues and specs for this repo live as GitHub issues. Use the \`gh\` CLI for all operations.

## Conventions

- Create an issue: \`gh issue create --title "..." --body "..."\`
- Read an issue: \`gh issue view <number> --comments\`
- List issues: \`gh issue list --state open --json number,title,body,labels\`
- Comment: \`gh issue comment <number> --body "..."\`
- Apply or remove labels: \`gh issue edit <number> --add-label "..."\` / \`--remove-label "..."\`
- Close: \`gh issue close <number>\`
`;
const DOMAIN = `# Domain Docs

How the engineering skills consume this repo's domain documentation.

- Read \`GLOSSARY.md\` at the repo root and any ADRs in \`docs/adr/\` that touch the area you are working in.
- If they do not exist, proceed silently; they are created lazily when terms or decisions are resolved.
`;

function labelsDoc(labels: Record<string, string>) {
  const rows = LABEL_ROLES.map((r) => {
    const mine = String(labels[r] ?? r).replace(/[`|\r\n]/g, "").trim() || r;
    return `| \`${r}\` | \`${mine}\` | ${MEANING[r]} |`;
  });
  return `# Triage Labels

The skills speak in terms of five canonical triage roles. This file maps them to the label strings used in this repo's issue tracker.

| Label in mattpocock/skills | Label in our tracker | Meaning |
| --- | --- | --- |
${rows.join("\n")}

When a skill mentions a role, use the label string from this table.
`;
}

function claudeSection(tracker: Tracker) {
  const issue = tracker === "github"
    ? "Issues and specs are GitHub issues, worked with the `gh` CLI. See `docs/agents/issue-tracker.md`."
    : "Issues and specs are local markdown files under `.scratch/<feature>/`. See `docs/agents/issue-tracker.md`.";
  return `## Agent skills

### Issue tracker

${issue}

### Triage labels

Five-role vocabulary mapped in \`docs/agents/triage-labels.md\`.

### Domain docs

Single-context: one \`GLOSSARY.md\` + \`docs/adr/\` at the repo root. See \`docs/agents/domain.md\`.
`;
}

/** Writes the tracker, label and domain docs and the CLAUDE.md pointer. Never overwrites an existing doc file. */
export function runSetup(repo: string, tracker: Tracker, labels: Record<string, string> = {}): string[] {
  const written: string[] = [];
  const put = (rel: string, text: string) => {
    const file = join(repo, rel);
    if (existsSync(file)) return;
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, text);
    written.push(rel);
  };
  put("docs/agents/issue-tracker.md", tracker === "github" ? GITHUB_TRACKER : LOCAL_TRACKER);
  put("docs/agents/triage-labels.md", labelsDoc(labels));
  put("docs/agents/domain.md", DOMAIN);
  if (tracker === "local") mkdirSync(join(repo, ".scratch"), { recursive: true });
  const claude = join(repo, "CLAUDE.md");
  const existing = existsSync(claude) ? readFileSync(claude, "utf8") : "";
  if (!/^## Agent skills/m.test(existing)) {
    writeFileSync(claude, existing ? `${existing.replace(/\s*$/, "")}\n\n${claudeSection(tracker)}` : claudeSection(tracker));
    written.push("CLAUDE.md");
  }
  return written;
}

export const validProjectName = (name: unknown): name is string =>
  typeof name === "string" && /^[A-Za-z0-9][A-Za-z0-9._ -]*$/.test(name) && !name.endsWith(".") && name.length <= 100;

/** What creating a project will do, shown to the user before anything is written. */
export function newProjectSteps(path: string, github: boolean): string[] {
  return [
    `Create the folder ${path}`,
    "Run git init and add README.md and .gitignore",
    "Set up the skills layout: docs/agents/ and CLAUDE.md, with a local .scratch/ tracker",
    "Make the first commit",
    ...(github ? ["Create a private GitHub repository with the gh CLI and push to it"] : []),
  ];
}

/** True when the target is missing or an empty folder. */
export function isFreeTarget(dir: string) {
  return !existsSync(dir) || readdirSync(dir).length === 0;
}

/** Creates the folder, repo, starter files and first commit. Throws on git failure. */
export function scaffoldProject(dir: string, name: string) {
  mkdirSync(dir, { recursive: true });
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git("init");
  writeFileSync(join(dir, "README.md"), `# ${name}\n`);
  writeFileSync(join(dir, ".gitignore"), "node_modules/\n.env\n.env.*\n!.env.example\ndist/\n");
  runSetup(dir, "local");
  git("add", "-A");
  git("-c", "user.name=Bridge", "-c", "user.email=bridge@localhost", "-c", "commit.gpgsign=false", "commit", "-m", "Initial commit");
}
