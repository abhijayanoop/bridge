import { existsSync, readdirSync, readFileSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { join } from "node:path";

export const COLUMNS = ["backlog", "in-progress", "review", "done"] as const;
export type Column = (typeof COLUMNS)[number];

export interface Blocker { id: string; key: string; column: Column | null; done: boolean }
export interface Ticket {
  /** `<feature>/<NN>`, unique within a repo. */
  id: string;
  repoId: string;
  feature: string;
  /** The NN prefix of the file name. */
  key: string;
  title: string;
  /** Raw Status value as written in the file. */
  status: string;
  column: Column;
  agent: string | null;
  blockers: Blocker[];
  /** True while any blocker is not done (never for a done ticket). */
  blocked: boolean;
  /** Path relative to the repo root, with forward slashes. */
  file: string;
}

/** Status strings (see docs/ticket-status-mapping.md). Anything unknown is Backlog. */
const COLUMN_OF: Record<string, Column> = {
  "in-progress": "in-progress", claimed: "in-progress",
  "in-review": "review", review: "review",
  done: "done", resolved: "done", wontfix: "done",
};
/** What a drop into each column writes. Backlog keeps an existing triage label. */
const WRITE_AS: Record<Column, string> = {
  backlog: "ready-for-agent", "in-progress": "in-progress", review: "in-review", done: "done",
};

const META = /^(\*\*)?(Status|Blocked by|Assigned to|Agent):(\*\*)?[ \t]*(.*?)[ \t]*$/i;

const columnOf = (status: string): Column => COLUMN_OF[status] ?? "backlog";
const normStatus = (s: string) => (s.trim().split(/\s+/).join("-") || "").toLowerCase();

interface Parsed { id: string; feature: string; key: string; title: string; status: string; agent: string | null; blockerRefs: string[]; file: string }

function parseFile(feature: string, name: string, text: string, rel: string): Parsed {
  const key = name.match(/^(\d+)/)![1]!;
  let title = name.replace(/\.md$/, "");
  let status = "";
  let agent: string | null = null;
  let blockerRefs: string[] = [];
  let titled = false;
  for (const line of text.split(/\r?\n/)) {
    if (!titled && line.startsWith("# ")) {
      titled = true;
      title = line.slice(2).replace(/^\s*\d+\s*[:.\-]\s*/, "").trim() || title;
      continue;
    }
    if (line.startsWith("## ")) break; // metadata lives above the first section
    const m = line.match(META);
    if (!m) continue;
    const value = m[4]!;
    switch (m[2]!.toLowerCase()) {
      case "status": status = normStatus(value); break;
      case "blocked by":
        blockerRefs = value.split(/[,\s]+/).filter((t) => /^(\w[\w-]*\/)?\d+$/.test(t));
        break;
      default: agent = value && !/^(none|-|unassigned)$/i.test(value) ? value : null;
    }
  }
  return { id: `${feature}/${key}`, feature, key, title, status, agent, blockerRefs, file: rel };
}

function scan(repoPath: string): Parsed[] {
  const root = join(repoPath, ".scratch");
  if (!existsSync(root)) return [];
  const out: Parsed[] = [];
  for (const feature of readdirSync(root, { withFileTypes: true })) {
    if (!feature.isDirectory()) continue;
    const dir = join(root, feature.name, "issues");
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).sort()) {
      if (!/^\d+.*\.md$/.test(f)) continue;
      out.push(parseFile(feature.name, f, readFileSync(join(dir, f), "utf8"), `.scratch/${feature.name}/issues/${f}`));
    }
  }
  return out;
}

/** The ticket files are the only source of truth: every call re-reads them. */
export function readTickets(repoPath: string, repoId: string): Ticket[] {
  const parsed = scan(repoPath);
  const columns = new Map(parsed.map((p) => [p.id, columnOf(p.status)]));
  const numbered = new Map(parsed.map((p) => [`${p.feature}/${Number(p.key)}`, p.id]));
  return parsed.map((p) => {
    const blockers = p.blockerRefs.map((ref): Blocker => {
      const [feat, num] = ref.includes("/") ? ref.split("/") as [string, string] : [p.feature, ref];
      const id = numbered.get(`${feat}/${Number(num)}`);
      const column = id ? columns.get(id)! : null;
      return { id: id ?? `${feat}/${num}`, key: num, column, done: column === "done" };
    });
    const column = columnOf(p.status);
    return {
      ...p, repoId, column, blockers,
      blocked: column !== "done" && blockers.some((b) => !b.done),
    };
  });
}

/** Writes the column's status into the ticket file. Returns the updated ticket, or null if unknown. */
export function moveTicket(repoPath: string, repoId: string, ticketId: string, column: Column): Ticket | null {
  const ticket = readTickets(repoPath, repoId).find((t) => t.id === ticketId);
  if (!ticket) return null;
  if (ticket.column !== column) {
    const path = join(repoPath, ticket.file);
    const text = readFileSync(path, "utf8");
    const eol = text.includes("\r\n") ? "\r\n" : "\n";
    const lines = text.split(/\r?\n/);
    const end = lines.findIndex((l) => l.startsWith("## "));
    const header = end === -1 ? lines.length : end;
    const at = lines.findIndex((l, i) => i < header && /^(\*\*)?Status:/i.test(l));
    const value = WRITE_AS[column];
    if (at !== -1) {
      const bold = lines[at]!.startsWith("**");
      lines[at] = bold ? `**Status:** ${value}` : `Status: ${value}`;
    } else {
      const after = lines.findIndex((l, i) => i < header && /^(\*\*)?Blocked by:/i.test(l));
      const title = lines.findIndex((l) => l.startsWith("# "));
      lines.splice((after !== -1 ? after : title !== -1 ? title : -1) + 1, 0, `Status: ${value}`);
    }
    writeFileSync(path, lines.join(eol));
  }
  return readTickets(repoPath, repoId).find((t) => t.id === ticketId) ?? null;
}

/** Calls onChange when any file under the repo's .scratch changes. Returns a stop function. */
export function watchTickets(repoPath: string, onChange: () => void): (() => void) | null {
  const root = join(repoPath, ".scratch");
  if (!existsSync(root)) return null;
  let timer: NodeJS.Timeout | undefined;
  let watcher: FSWatcher;
  try {
    watcher = watch(root, { recursive: true }, () => {
      clearTimeout(timer);
      timer = setTimeout(onChange, 50);
    });
  } catch { return null; }
  watcher.on("error", () => {});
  return () => { clearTimeout(timer); watcher.close(); };
}
