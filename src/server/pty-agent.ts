import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, extname, join } from "node:path";
import * as pty from "@lydell/node-pty";
import type { AgentEvent, AgentRunner, AgentSpec } from "./agent-runner.ts";

export interface PtyRunnerOptions {
  /** Executable name or path. Defaults to the interactive `claude` CLI. */
  command?: string;
  /** Builds the argument list; the default passes the ticket task as the CLI's initial prompt. */
  args?: (spec: AgentSpec) => string[];
  env?: NodeJS.ProcessEnv;
  cols?: number;
  rows?: number;
}

/** Finds an executable on PATH, honouring PATHEXT on Windows. Returns the input if not found. */
export function resolveCommand(command: string, env: NodeJS.ProcessEnv = process.env): string {
  if (/[\\/]/.test(command) && existsSync(command)) return command;
  const exts = process.platform === "win32" && !extname(command)
    ? (env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").filter(Boolean)
    : [""];
  for (const dir of (env.PATH ?? env.Path ?? "").split(delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const full = join(dir, command + ext);
      if (existsSync(full)) return full;
    }
  }
  return command;
}

/** Real adapter: runs a command in a pseudo-terminal and relays bytes both ways. */
export function createPtyAgentRunner(opts: PtyRunnerOptions = {}): AgentRunner {
  const sessions = new Map<string, pty.IPty>();
  const command = opts.command ?? "claude";
  const argsFor = opts.args ?? ((spec: AgentSpec) => [
    ...(spec.task ? [spec.task] : []),
    ...(spec.mcpConfig ? ["--mcp-config", spec.mcpConfig] : []),
    // Only an isolated sandbox may skip permission prompts; local mode keeps them.
    ...(spec.permissionPrompts === false ? ["--dangerously-skip-permissions"] : []),
  ]);
  return {
    start(spec, emit: (event: AgentEvent) => void) {
      const env = { ...process.env, ...opts.env, ...spec.env } as Record<string, string>;
      let file = resolveCommand(command, env);
      let args = argsFor(spec);
      // npm-installed CLIs are .cmd shims on Windows; a pty cannot exec them directly.
      if (/\.(cmd|bat)$/i.test(file)) { args = ["/d", "/c", file, ...args]; file = env.ComSpec ?? "cmd.exe"; }
      try {
        const term = pty.spawn(file, args, {
          name: "xterm-256color", cols: opts.cols ?? 100, rows: opts.rows ?? 30,
          cwd: spec.cwd && existsSync(spec.cwd) ? spec.cwd : process.cwd(), env,
        });
        sessions.set(spec.id, term);
        emit({ type: "status", status: "working" });
        term.onData((data) => emit({ type: "output", data }));
        term.onExit(() => {
          if (sessions.get(spec.id) === term) sessions.delete(spec.id);
          emit({ type: "status", status: "done" });
        });
      } catch (err) {
        emit({ type: "output", data: `\r\nCould not start ${command}: ${(err as Error).message}\r\n` });
        emit({ type: "status", status: "done" });
      }
    },
    stop(agentId) {
      const term = sessions.get(agentId);
      if (!term) return;
      // On Windows the CLI runs under cmd/node children; killing only the pty leaves them, so end the whole tree.
      let treeError = "";
      if (process.platform === "win32") {
        const r = spawnSync("taskkill", ["/PID", String(term.pid), "/T", "/F"], { encoding: "utf8", windowsHide: true });
        if (r.status === 0) return;
        const said = `${r.stderr ?? ""}${r.stdout ?? ""}`.trim();
        if (/not found|no running instance/i.test(said)) return; // already gone
        treeError = said || (r.error?.message ?? `taskkill exited with ${r.status}`);
      }
      try { term.kill(); } catch {
        if (treeError) throw new Error(`could not end the agent's process tree: ${treeError}`);
        return; // already gone
      }
      if (treeError) throw new Error(`the agent's process tree may still be running: ${treeError}`);
    },
    write(agentId, data) {
      sessions.get(agentId)?.write(data);
    },
    resize(agentId, cols, rows) {
      try { sessions.get(agentId)?.resize(Math.max(2, cols), Math.max(2, rows)); } catch { /* exited */ }
    },
  };
}
