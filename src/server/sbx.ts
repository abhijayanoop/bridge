import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import type { AgentEvent, AgentRunner, AgentSpec } from "./agent-runner.ts";
import type { NetworkRules } from "./approvals.ts";
import { createPtyAgentRunner } from "./pty-agent.ts";
import type { Mode } from "./workspace.ts";

/** Runs a command and never throws: a missing executable is reported as a non-zero code. */
export type CommandRunner = (command: string, args: string[], opts?: { cwd?: string; timeoutMs?: number }) => Promise<{ code: number; stdout: string; stderr: string }>;

export const nodeCommandRunner: CommandRunner = (command, args, opts) =>
  new Promise((resolve) => {
    execFile(command, args, { encoding: "utf8", timeout: opts?.timeoutMs ?? 120_000, windowsHide: true, cwd: opts?.cwd }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as any).code === "number" ? (err as any).code : 127) : 0;
      resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
    });
  });

/**
 * ALL knowledge of the `sbx` (Docker Sandboxes) command line lives here, as verified on this machine
 * with sbx v0.51.0 (see docs/sbx-cli-notes.md). `--no-input` makes sbx fail instead of prompting.
 */
export const SBX = {
  /** Probe: exits 0 when the CLI is installed and runnable. */
  version: () => ["version"],
  /** Creates a named Claude sandbox that mounts `workspace` (Bridge's per-ticket clone). */
  create: (name: string, workspace: string, env: Record<string, string> = {}) => [
    "--no-input", "create", "--name", name,
    ...Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
    "claude", workspace,
  ],
  /** Lets one sandbox reach Bridge's own daemon on the host (as `host.docker.internal`). Per sandbox, never global. */
  allowDaemon: (name: string, port: string) => ["--no-input", "policy", "allow", "network", "--sandbox", name, `localhost:${port}`],
  /** Interactive agent session inside an existing sandbox (a stopped one is started first). */
  exec: (name: string, agentArgs: string[]) => ["exec", "-it", name, "claude", ...agentArgs],
  /** Force-removes a sandbox without asking. */
  remove: (name: string) => ["--no-input", "rm", "--force", name],
  /** Global network allow rule, enforced by the sandbox proxy outside the sandbox. */
  allowNetwork: (domain: string) => ["--no-input", "policy", "allow", "network", domain],
  removeNetwork: (domain: string) => ["--no-input", "policy", "rm", "network", "--force", "--resource", domain],
};

/** Where winget puts sbx; a session started before the install may not have it on PATH. */
export function sbxFallbackDir(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.LOCALAPPDATA ? join(env.LOCALAPPDATA, "DockerSandboxes", "bin") : undefined;
}

/** The sbx executable: bare name when it is on PATH, otherwise the winget directory, otherwise the bare name. */
export function findSbx(env: NodeJS.ProcessEnv = process.env, exists: (p: string) => boolean = existsSync): string {
  const exe = process.platform === "win32" ? "sbx.exe" : "sbx";
  for (const dir of (env.PATH ?? env.Path ?? "").split(delimiter).filter(Boolean)) if (exists(join(dir, exe))) return "sbx";
  const fallback = sbxFallbackDir(env);
  if (fallback && exists(join(fallback, exe))) return join(fallback, exe);
  return "sbx";
}

export const sandboxName = (agentId: string) => `bridge-${agentId}`;

/** Where a host path appears inside the sandbox: a Windows drive path is mounted at /<drive>/<rest>. */
export function sandboxPath(hostPath: string): string {
  const m = hostPath.match(/^([A-Za-z]):[\\/](.*)$/);
  return m ? `/${m[1]!.toLowerCase()}/${m[2]!.replaceAll("\\", "/")}` : hostPath;
}

/** Arguments for claude inside the sandbox: full permissions, because the sandbox is the boundary. */
function agentArgs(spec: AgentSpec): string[] {
  return [
    ...(spec.task ? [spec.task] : []),
    ...(spec.mcpConfig ? ["--mcp-config", sandboxPath(spec.mcpConfig)] : []),
    "--dangerously-skip-permissions",
  ];
}

export type InnerFactory = (command: string, argsFor: (spec: AgentSpec) => string[]) => AgentRunner;
const defaultInner: InnerFactory = (command, args) => createPtyAgentRunner({ command, args });

/** Sandbox implementation of the runner port: creates a sandbox per agent, then runs claude inside it. */
export function createSbxAgentRunner(run: CommandRunner, sbx = "sbx", createInner: InnerFactory = defaultInner): AgentRunner {
  const inner = createInner(sbx, (spec) => SBX.exec(sandboxName(spec.id), agentArgs(spec)));
  /** Agents stopped before their sandbox finished creating must not start. */
  const cancelled = new Set<string>();
  return {
    ...inner,
    start(spec, emit: (event: AgentEvent) => void) {
      const name = sandboxName(spec.id);
      emit({ type: "status", status: "working" });
      void run(sbx, SBX.create(name, spec.cwd ?? process.cwd(), spec.env)).then((r) => {
        if (cancelled.delete(spec.id)) { void run(sbx, SBX.remove(name)); return; }
        if (r.code !== 0) {
          emit({ type: "output", data: `\r\nCould not create the sandbox (sbx exit ${r.code}): ${(r.stderr || r.stdout).trim()}\r\n` });
          emit({ type: "status", status: "done" });
          return;
        }
        // Bridge's own daemon port is opened for this sandbox only, so hooks and MCP can report back.
        const port = spec.hook ? new URL(spec.hook.url).port : "";
        const ready = port ? run(sbx, SBX.allowDaemon(name, port)) : Promise.resolve(r);
        void ready.then(() => {
          if (cancelled.delete(spec.id)) { void run(sbx, SBX.remove(name)); return; }
          inner.start(spec, emit);
        });
      });
    },
    stop(agentId) {
      cancelled.add(agentId);
      inner.stop(agentId);
      void run(sbx, SBX.remove(sandboxName(agentId))).then((r) => { if (r.code === 0) cancelled.delete(agentId); });
    },
  };
}

/** Network allow-list backed by `sbx policy`. Only rules this instance added are ever removed. */
export function createSbxNetworkRules(run: CommandRunner, sbx = "sbx"): NetworkRules {
  const added = new Set<string>();
  return {
    add(domain) {
      if (added.has(domain)) return false;
      added.add(domain);
      void run(sbx, SBX.allowNetwork(domain));
      return true;
    },
    remove(domain) {
      if (!added.delete(domain)) return;
      void run(sbx, SBX.removeNetwork(domain));
    },
  };
}

export interface ResolvedSandbox {
  mode: Mode;
  runner: AgentRunner;
  networkRules: NetworkRules;
  /** Human-readable explanation of the choice; shown in the UI and the log. */
  notice: string;
}

/** Picks the Docker Sandboxes runner when `sbx` works, otherwise the given local runner with a clear message. */
export async function resolveSandbox(opts: { run?: CommandRunner; local: AgentRunner; createInner?: InnerFactory; sbx?: string }): Promise<ResolvedSandbox> {
  const run = opts.run ?? nodeCommandRunner;
  const sbx = opts.sbx ?? findSbx();
  const probe = await run(sbx, SBX.version()).catch(() => ({ code: 127, stdout: "", stderr: "" }));
  if (probe.code === 0) {
    return {
      mode: "sandbox",
      runner: createSbxAgentRunner(run, sbx, opts.createInner),
      networkRules: createSbxNetworkRules(run, sbx),
      notice: "Docker Sandboxes (sbx) found: workers run inside sandboxes.",
    };
  }
  return {
    mode: "local",
    runner: opts.local,
    networkRules: { add: () => true, remove: () => {} },
    notice: "Docker Sandboxes (sbx) was not found or did not run, so workers use local mode: no sandbox, normal permission prompts. Install sbx (winget) and run `sbx login` to isolate workers.",
  };
}
