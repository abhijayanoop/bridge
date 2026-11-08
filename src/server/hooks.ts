import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SCRIPT = (url: string, token: string) => `// Written by Bridge. Reports this agent's state to the local Bridge daemon.
// Usage: node bridge-hook.mjs <idle|working|blocked|waiting|done> [activity]
const [status, activity] = process.argv.slice(2);
let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => { raw += c; });
const send = async () => {
  let input = {};
  try { input = JSON.parse(raw || "{}"); } catch {}
  const body = { status, activity, tool: input.tool_name, command: typeof input.tool_input?.command === "string" ? input.tool_input.command.slice(0, 300) : undefined };
  try {
    await fetch(${JSON.stringify(url)}, { method: "POST", headers: { "content-type": "application/json", "x-bridge-token": ${JSON.stringify(token)} }, body: JSON.stringify(body), signal: AbortSignal.timeout(2000) });
  } catch {}
  process.exit(0);
};
process.stdin.on("end", send);
setTimeout(send, 1500);
`;

const MARK = "bridge-hook.mjs";
const cmd = (status: string, activity?: string) =>
  `node "$CLAUDE_PROJECT_DIR/.claude/${MARK}" ${status}${activity ? ` ${activity}` : ""}`;

/** Hook events Claude Code fires, and the Bridge status each one reports. */
const EVENTS: Record<string, string> = {
  UserPromptSubmit: cmd("working"),
  PreToolUse: cmd("working"),
  PostToolUseFailure: cmd("working", "debugging"),
  Notification: cmd("waiting"),
  Stop: cmd("idle"),
  SessionEnd: cmd("done"),
};

/**
 * Writes the hook script and Claude Code hook config into an agent's workspace
 * (`.claude/settings.local.json`, merged with anything already there).
 */
export function writeHookConfig(cwd: string, url: string, token: string): void {
  const dir = join(cwd, ".claude");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, MARK), SCRIPT(url, token));
  const file = join(dir, "settings.local.json");
  let settings: any = {};
  try { settings = JSON.parse(readFileSync(file, "utf8")); } catch { /* new file */ }
  settings.hooks ??= {};
  for (const [event, command] of Object.entries(EVENTS)) {
    const groups: any[] = (settings.hooks[event] ??= []);
    const kept = groups.filter((g) => !JSON.stringify(g).includes(MARK));
    kept.push({ matcher: "", hooks: [{ type: "command", command }] });
    settings.hooks[event] = kept;
  }
  writeFileSync(file, JSON.stringify(settings, null, 2) + "\n");
}
