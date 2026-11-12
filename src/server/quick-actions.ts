/** One command-palette action: a normal agent started with one installed skill. */
export interface QuickAction { id: string; label: string; description: string; skill: string }

export const QUICK_ACTIONS: readonly QuickAction[] = [
  { id: "architecture", label: "Architecture review", description: "Map module boundaries and propose deeper, simpler interfaces", skill: "mattpocock-skills:codebase-design" },
  { id: "diagnose", label: "Diagnose a bug", description: "Reproduce, write a failing test, find the cause, then fix", skill: "mattpocock-skills:diagnosing-bugs" },
  { id: "research", label: "Research", description: "Answer a question from primary sources and save notes to the repo", skill: "mattpocock-skills:research" },
  { id: "prototype", label: "Prototype", description: "Build a throwaway version to settle a design question", skill: "mattpocock-skills:prototype" },
  { id: "triage", label: "Triage", description: "Sort new issues into tickets with agent-ready briefs", skill: "mattpocock-skills:triage" },
  { id: "handoff", label: "Hand off", description: "Compact this work so a fresh agent can pick it up", skill: "mattpocock-skills:handoff" },
];

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

/** The first prompt for a palette agent. One line, because it travels as a command-line argument. */
export function quickActionTask(action: QuickAction, context: string): string {
  const ctx = oneLine(context);
  return [
    `Use the ${action.skill} skill: ${action.description.toLowerCase()}.`,
    ctx ? `The user adds: ${ctx}.` : "",
    `Use the Bridge tools: set_my_status to "working" when you start and "done" when finished; ask_user for a question only the user can answer; request_access for a network domain, secret or push you need.`,
    `Never merge: the user merges.`,
  ].filter(Boolean).join(" ");
}

/** The first prompt for the retro agent that looks back on a finished feature. */
export function retroTask(f: { description: string; slug: string }): string {
  return [
    `Use the mattpocock-skills:retro skill to look back on this finished feature: ${oneLine(f.description)}.`,
    `Its spec and tickets are in .scratch/${f.slug}/; the git log shows what was built.`,
    `Use the Bridge tools: set_my_status to "working" when you start and "done" when finished; ask_user for a question only the user can answer.`,
    `Never merge: the user merges.`,
  ].join(" ");
}

/** The first prompt for the Analyst: read-only analysis of real data through the host-side Bridge tools only. */
export function analystTask(context: string): string {
  const ctx = oneLine(context);
  return [
    `You are the Bridge Analyst. Analyse the user's real data, read-only.`,
    ctx ? `The user asks: ${ctx}.` : `Ask the user with ask_user what they want to know.`,
    `Call list_datasets to see which databases and tables you may use, then query_dataset to read them: it needs the user's approval for each dataset and returns names and identifiers masked.`,
    `Use only those tools for data: never run a database client or script, never look for connection strings or credentials, and never read files under .bridge or its secrets folder.`,
    `Report findings as analysis (counts, trends, patterns); never try to work out who a masked person is.`,
    `Use the Bridge tools: set_my_status to "working" when you start and "done" when finished.`,
  ].join(" ");
}
