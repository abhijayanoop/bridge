import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MERGE_CHECK_SOURCE } from "./approvals.ts";

const SCRIPT = (url: string, token: string) => `// Written by Bridge. Reports this agent's state to the local Bridge daemon.
// Usage: node bridge-hook.mjs <idle|working|blocked|waiting|done> [activity]
const [status, activity] = process.argv.slice(2);
const isMergeCommand = ${MERGE_CHECK_SOURCE};
let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => { raw += c; });
const send = async () => {
  let input = {};
  try { input = JSON.parse(raw || "{}"); } catch {}
  if (input.tool_name === "Bash" && typeof input.tool_input?.command === "string" && isMergeCommand(input.tool_input.command)) {
    process.stderr.write("Bridge refused this command: agents may never merge. Push your branch and open a pull request; the user merges.\\n");
    process.exit(2);
  }
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
const SH_MARK = "bridge-hook.sh";

/**
 * Hook script for sandboxes, whose image has no Node: plain sh and curl. It posts Claude's raw hook input
 * to the daemon, which makes the same decisions (status, merge refusal) and answers 403 to refuse.
 */
const SH_SCRIPT = (url: string, token: string) => `#!/bin/sh
# Written by Bridge. Usage: sh bridge-hook.sh <status> [activity]
resp=$(cat | curl -s -m 2 -w '\n%{http_code}' -X POST -H 'content-type: application/json' -H 'x-bridge-token: ${token}' --data-binary @- "${url}?status=$1&activity=$2") || exit 0
code=$(printf '%s' "$resp" | tail -n 1)
if [ "$code" = 403 ]; then printf '%s\n' "$resp" | sed '$d' >&2; exit 2; fi
exit 0
`;

const cmd = (runner: "node" | "sh", status: string, activity?: string) =>
  `${runner} "$CLAUDE_PROJECT_DIR/.claude/${runner === "node" ? MARK : SH_MARK}" ${status}${activity ? ` ${activity}` : ""}`;

/** Hook events Claude Code fires, and the Bridge status each one reports. */
const events = (runner: "node" | "sh"): Record<string, string> => ({
  UserPromptSubmit: cmd(runner, "working"),
  PreToolUse: cmd(runner, "working"),
  PostToolUseFailure: cmd(runner, "working", "debugging"),
  Notification: cmd(runner, "waiting"),
  Stop: cmd(runner, "idle"),
  SessionEnd: cmd(runner, "done"),
});

/**
 * Writes this agent's MCP config to `.claude/bridge-mcp-<agentId>.json` (pass it to the CLI with
 * `--mcp-config`) and allows the Bridge tools in `settings.local.json`. Existing files are merged.
 * Returns the config path.
 */
export function writeMcpConfig(cwd: string, agentId: string, url: string, token: string): string {
  const dir = join(cwd, ".claude");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `bridge-mcp-${agentId}.json`);
  let config: any = {};
  try { config = JSON.parse(readFileSync(file, "utf8")); } catch { /* new file */ }
  config.mcpServers = { ...config.mcpServers, bridge: { type: "http", url, headers: { "x-bridge-token": token } } };
  writeFileSync(file, JSON.stringify(config, null, 2) + "\n");
  const settingsFile = join(dir, "settings.local.json");
  let settings: any = {};
  try { settings = JSON.parse(readFileSync(settingsFile, "utf8")); } catch { /* new file */ }
  settings.permissions ??= {};
  const allow: string[] = (settings.permissions.allow ??= []);
  if (!allow.includes("mcp__bridge")) allow.push("mcp__bridge");
  writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + "\n");
  return file;
}

/**
 * Writes the hook script and Claude Code hook config into an agent's workspace
 * (`.claude/settings.local.json`, merged with anything already there).
 */
export function writeHookConfig(cwd: string, url: string, token: string, runner: "node" | "sh" = "node"): void {
  const dir = join(cwd, ".claude");
  mkdirSync(dir, { recursive: true });
  if (runner === "node") writeFileSync(join(dir, MARK), SCRIPT(url, token));
  else writeFileSync(join(dir, SH_MARK), SH_SCRIPT(url, token));
  const file = join(dir, "settings.local.json");
  let settings: any = {};
  try { settings = JSON.parse(readFileSync(file, "utf8")); } catch { /* new file */ }
  settings.hooks ??= {};
  for (const [event, command] of Object.entries(events(runner))) {
    const groups: any[] = (settings.hooks[event] ??= []);
    const kept = groups.filter((g) => !JSON.stringify(g).includes("bridge-hook."));
    kept.push({ matcher: "", hooks: [{ type: "command", command }] });
    settings.hooks[event] = kept;
  }
  writeFileSync(file, JSON.stringify(settings, null, 2) + "\n");
}
