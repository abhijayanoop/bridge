import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { startDaemon } from "../src/server/daemon.ts";
import { createFakeAgentRunner } from "../src/server/fake-agent.ts";
import type { AgentRunner, AgentSpec } from "../src/server/agent-runner.ts";
import { findSbx, resolveSandbox, sandboxPath, type CommandRunner } from "../src/server/sbx.ts";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

/** Fake command runner: records every call; `version` succeeds unless `missing`; `create` fails if `failCreate`. */
function fakeRun(missing: boolean, failCreate: boolean) {
  const calls: string[][] = [];
  const run: CommandRunner = async (cmd, args) => {
    calls.push([cmd, ...args]);
    if (missing) return { code: 127, stdout: "", stderr: "not found" };
    if (failCreate && args.includes("create")) return { code: 1, stdout: "", stderr: "no capacity" };
    return { code: 0, stdout: "sbx version v0.51.0", stderr: "" };
  };
  return { run, calls };
}

async function boot(missing: boolean, failCreate = false) {
  const dir = mkdtempSync(join(tmpdir(), "bridge-sbx-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const repo = join(dir, "repo");
  mkdirSync(join(repo, ".scratch", "f", "issues"), { recursive: true });
  writeFileSync(join(repo, ".scratch", "f", "issues", "01-add-thing.md"), "# 01: Add thing\n\n**Status:** ready-for-agent\n");
  writeFileSync(join(repo, "app.txt"), "hello\n");
  const g = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: repo });
  g("init", "-b", "main"); g("add", "-A"); g("commit", "-m", "init");

  const { run, calls } = fakeRun(missing, failCreate);
  const innerArgs: string[][] = [];
  const specs: AgentSpec[] = [];
  const fake = createFakeAgentRunner([]);
  const sandbox = await resolveSandbox({
    run,
    sbx: "sbx",
    createInner: (command, argsFor) => ({
      ...fake,
      start(spec, emit) { specs.push(spec); innerArgs.push([command, ...argsFor(spec)]); fake.start(spec, emit); },
    }),
    local: { ...fake, start(spec, emit) { specs.push(spec); innerArgs.push(["local"]); fake.start(spec, emit); } } satisfies AgentRunner,
  });
  const daemon = await startDaemon({ dataDir: join(dir, "data"), runner: sandbox.runner, mode: sandbox.mode, networkRules: sandbox.networkRules, sandboxNotice: sandbox.notice, agentHost: sandbox.mode === "sandbox" ? "host.docker.internal" : undefined });
  cleanups.push(() => daemon.close());
  const post = async (path: string, body: unknown) => {
    const r = await fetch(daemon.url + path, { method: "POST", body: JSON.stringify(body) });
    return { status: r.status, json: (await r.json()) as any };
  };
  const project = (await post("/api/projects", { name: "demo", path: repo })).json;
  return { daemon, post, project, calls, innerArgs, specs, sandbox };
}

describe("Docker Sandboxes adapter", () => {
  it("is selected when sbx is available: a sandbox is created on the ticket clone and claude runs in it with full permissions", async () => {
    const t = await boot(false);
    expect(t.sandbox.mode).toBe("sandbox");
    const r = await t.post("/api/agents", { projectId: t.project.id, name: "A", ticket: "f/01" });
    expect(r.json.workspace.mode).toBe("sandbox");
    await expect.poll(() => t.specs.length).toBe(1);
    expect(t.specs[0]!.permissionPrompts).toBe(false);
    const name = `bridge-${r.json.id}`;
    // The sandbox mounts the per-ticket clone, never the user's working copy.
    expect(r.json.workspace.path).not.toBe(t.project.path);
    expect(t.calls).toContainEqual(["sbx", "--no-input", "create", "--name", name, "claude", r.json.workspace.path]);
    const [cmd, ...args] = t.innerArgs[0]!;
    expect(cmd).toBe("sbx");
    expect(args.slice(0, 4)).toEqual(["exec", "-it", name, "claude"]);
    expect(args).toContain("--dangerously-skip-permissions");
    // Paths and URLs are as the sandbox sees them: mount-style path, host.docker.internal, and a per-sandbox allow for the daemon port.
    const mcp = args[args.indexOf("--mcp-config") + 1]!;
    expect(mcp).toBe(sandboxPath(join(r.json.workspace.path, ".claude", `bridge-mcp-${r.json.id}.json`)));
    expect(mcp).not.toMatch(/\\|^[A-Za-z]:/);
    expect(t.calls).toContainEqual(["sbx", "--no-input", "policy", "allow", "network", "--sandbox", name, `localhost:${new URL(t.daemon.url).port}`]);
    const cfg = JSON.parse(readFileSync(join(r.json.workspace.path, ".claude", `bridge-mcp-${r.json.id}.json`), "utf8"));
    expect(cfg.mcpServers.bridge.url).toMatch(/^http:\/\/host\.docker\.internal:/);
    const info = await (await fetch(t.daemon.url + "/api/sandbox")).json() as any;
    expect(info.mode).toBe("sandbox");
  });

  it("falls back to local mode with a clear message when sbx is missing", async () => {
    const t = await boot(true);
    expect(t.sandbox.mode).toBe("local");
    expect(t.sandbox.notice).toMatch(/sbx.*not.*(found|installed)/i);
    expect(t.sandbox.notice).toMatch(/local mode/i);
    const info = await (await fetch(t.daemon.url + "/api/sandbox")).json() as any;
    expect(info).toMatchObject({ mode: "local" });
    expect(info.message).toBe(t.sandbox.notice);
    const r = await t.post("/api/agents", { projectId: t.project.id, name: "A", ticket: "f/01" });
    expect(r.json.workspace.mode).toBe("local");
    await expect.poll(() => t.specs.length).toBe(1);
    expect(t.specs[0]!.permissionPrompts).toBe(true);
    expect(t.innerArgs[0]).toEqual(["local"]);
    expect(t.calls.every((c) => c[1] === "version")).toBe(true);
  });

  it("approved domains become global sbx network rules, once, and undo removes them; no secrets on any command line", async () => {
    const t = await boot(false);
    t.sandbox.networkRules.add("api.example.com");
    t.sandbox.networkRules.add("api.example.com");
    await expect.poll(() => t.calls.filter((c) => c.includes("allow")).length).toBe(1);
    expect(t.calls).toContainEqual(["sbx", "--no-input", "policy", "allow", "network", "api.example.com"]);
    t.sandbox.networkRules.remove("api.example.com");
    await expect.poll(() => t.calls.some((c) => c.includes("policy") && c.includes("rm"))).toBe(true);
    expect(t.calls).toContainEqual(["sbx", "--no-input", "policy", "rm", "network", "--force", "--resource", "api.example.com"]);
    // Removing a rule this instance never added does nothing.
    t.sandbox.networkRules.remove("other.example.com");
    expect(t.calls.filter((c) => c.includes("rm") && c.includes("policy"))).toHaveLength(1);
    expect(JSON.stringify(t.calls)).not.toMatch(/secret/i);
  });

  it("stopping an agent removes its sandbox", async () => {
    const t = await boot(false);
    const agent = (await t.post("/api/agents", { projectId: t.project.id, name: "A", ticket: "f/01" })).json;
    await t.post(`/api/agents/${agent.id}/stop`, {});
    await expect.poll(() => t.calls.some((c) => c.includes("rm") && c.includes("--force") && c.includes(`bridge-${agent.id}`))).toBe(true);
  });

  it("a failed sandbox creation ends the agent with sbx's message and never runs on the host", async () => {
    const t = await boot(false, true);
    const agent = (await t.post("/api/agents", { projectId: t.project.id, name: "A", ticket: "f/01" })).json;
    await expect.poll(async () => ((await (await fetch(t.daemon.url + "/api/agents")).json()) as any[]).find((a) => a.id === agent.id)?.status).toBe("done");
    const events = JSON.stringify(await (await fetch(`${t.daemon.url}/api/agents/${agent.id}/events`)).json());
    expect(events).toMatch(/Could not create the sandbox.*no capacity/);
    expect(t.specs).toHaveLength(0);
  });

  it("maps Windows host paths to their sandbox mount paths", () => {
    expect(sandboxPath("C:\\Users\\a b\\.bridge\\x.json")).toBe("/c/Users/a b/.bridge/x.json");
    expect(sandboxPath("/home/a/x.json")).toBe("/home/a/x.json");
  });

  it("finds sbx on PATH, else in the per-user winget directory, else the bare name", () => {
    const exe = process.platform === "win32" ? "sbx.exe" : "sbx";
    const local = join(tmpdir(), "LocalAppData");
    const fallback = join(local, "DockerSandboxes", "bin", exe);
    expect(findSbx({ PATH: "", LOCALAPPDATA: local }, (p) => p === fallback)).toBe(fallback);
    expect(findSbx({ PATH: join(tmpdir(), "x"), LOCALAPPDATA: local }, (p) => p === join(tmpdir(), "x", exe))).toBe("sbx");
    expect(findSbx({ PATH: "", LOCALAPPDATA: local }, () => false)).toBe("sbx");
  });
});
