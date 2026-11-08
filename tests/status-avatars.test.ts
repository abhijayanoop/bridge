import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startDaemon } from "../src/server/daemon.ts";
import { createFakeAgentRunner } from "../src/server/fake-agent.ts";
import type { AgentRunner, AgentSpec } from "../src/server/agent-runner.ts";
import { avatarState, orbMode, pickIdentity, PALETTE, SHAPE_KEYS } from "../src/shared/avatar.ts";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

async function boot() {
  const dir = mkdtempSync(join(tmpdir(), "bridge-av-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const repo = join(dir, "repo");
  mkdirSync(join(repo, ".scratch", "f", "issues"), { recursive: true });
  writeFileSync(join(repo, ".scratch", "f", "issues", "01-thing.md"), "# 01: Do the thing\n\n**Status:** ready-for-agent\n");
  const specs: AgentSpec[] = [];
  const fake = createFakeAgentRunner([]);
  const runner: AgentRunner = { ...fake, start(spec, emit) { specs.push(spec); fake.start(spec, emit); } };
  const daemon = await startDaemon({ dataDir: join(dir, "data"), runner });
  cleanups.push(() => daemon.close());
  const ws = new WebSocket(daemon.url.replace("http", "ws") + "/ws");
  const received: any[] = [];
  await new Promise((r) => ws.addEventListener("open", r, { once: true }));
  ws.addEventListener("message", (m) => received.push(JSON.parse(String(m.data))));
  cleanups.push(() => ws.close());
  const post = async (path: string, body: unknown, headers: Record<string, string> = {}) => {
    const r = await fetch(daemon.url + path, { method: "POST", body: JSON.stringify(body), headers });
    return { status: r.status, json: (await r.json()) as any };
  };
  const project = (await post("/api/projects", { name: "demo", path: repo })).json;
  const startAgent = async (extra: object = {}) => {
    const r = await post("/api/agents", { projectId: project.id, name: "A", ...extra });
    return { agent: r.json, spec: specs.at(-1)! };
  };
  const report = (spec: AgentSpec, agentId: string, body: unknown, token = spec.hook!.token) =>
    post(`/api/agents/${agentId}/hook`, body, { "x-bridge-token": token });
  return { daemon, received, post, project, repo, startAgent, report };
}

describe("agent status hooks via the public API", () => {
  it("writes hook config into the agent workspace at start", async () => {
    const { repo, startAgent } = await boot();
    await startAgent();
    const settings = JSON.parse(readFileSync(join(repo, ".claude", "settings.local.json"), "utf8"));
    for (const e of ["UserPromptSubmit", "PreToolUse", "Notification", "Stop", "SessionEnd"]) {
      expect(JSON.stringify(settings.hooks[e])).toContain("bridge-hook.mjs");
    }
    expect(existsSync(join(repo, ".claude", "bridge-hook.mjs"))).toBe(true);
  });

  it("keeps existing settings and does not duplicate hooks on a second agent", async () => {
    const { repo, startAgent } = await boot();
    mkdirSync(join(repo, ".claude"), { recursive: true });
    writeFileSync(join(repo, ".claude", "settings.local.json"), JSON.stringify({ permissions: { allow: ["Bash(ls)"] } }));
    await startAgent();
    await startAgent();
    const settings = JSON.parse(readFileSync(join(repo, ".claude", "settings.local.json"), "utf8"));
    expect(settings.permissions.allow).toEqual(["Bash(ls)"]);
    expect(settings.hooks.Stop).toHaveLength(1);
  });

  it("rejects hook calls without the agent's token", async () => {
    const { startAgent, report } = await boot();
    const { agent, spec } = await startAgent();
    expect((await report(spec, agent.id, { status: "working" }, "wrong")).status).toBe(401);
  });

  it("rejects an unknown status", async () => {
    const { startAgent, report } = await boot();
    const { agent, spec } = await startAgent();
    expect((await report(spec, agent.id, { status: "dancing" })).status).toBe(400);
  });

  it("reflects reported status in the agent record and broadcasts it", async () => {
    const { daemon, received, startAgent, report } = await boot();
    const { agent, spec } = await startAgent();
    for (const [status, state] of [["working", "implementing"], ["blocked", "blocked"], ["waiting", "listening"], ["idle", "idle"], ["done", "done"]] as const) {
      const r = await report(spec, agent.id, { status });
      expect(r.status).toBe(200);
      const listed = ((await (await fetch(`${daemon.url}/api/agents`)).json()) as any[])[0];
      expect(listed).toMatchObject({ status, avatarState: state });
      await expect.poll(() => received.some((m) => m.type === "agent" && m.agent.status === status && m.agent.avatarState === state)).toBe(true);
    }
  });

  it("maps tool use to a coarser activity", async () => {
    const { daemon, startAgent, report } = await boot();
    const { agent, spec } = await startAgent();
    const state = async () => ((await (await fetch(`${daemon.url}/api/agents`)).json()) as any[])[0].avatarState;
    await report(spec, agent.id, { status: "working", tool: "Grep" });
    expect(await state()).toBe("exploring");
    await report(spec, agent.id, { status: "working", tool: "Edit" });
    expect(await state()).toBe("implementing");
    await report(spec, agent.id, { status: "working", tool: "Bash", command: "gh pr create --fill" });
    expect(await state()).toBe("composing");
    await report(spec, agent.id, { status: "working", tool: "ExitPlanMode" });
    expect(await state()).toBe("planning");
    await report(spec, agent.id, { status: "working", activity: "debugging" });
    expect(await state()).toBe("debugging");
    await report(spec, agent.id, { status: "idle", activity: "debugging" });
    expect(await state()).toBe("idle");
  });

  it("assigns each agent in a project a distinct shape and palette colour", async () => {
    const { startAgent } = await boot();
    const made = [];
    for (let i = 0; i < 8; i++) made.push((await startAgent({ lead: i === 0 })).agent);
    expect(new Set(made.map((a) => a.shape)).size).toBe(8);
    expect(new Set(made.map((a) => a.color)).size).toBe(8);
    for (const a of made) { expect(SHAPE_KEYS).toContain(a.shape); expect(PALETTE).toContain(a.color); }
    expect(made[0].lead).toBe(true);
    expect(made[1].lead).toBe(false);
    expect((await startAgent()).agent.shape).toBeTruthy(); // a ninth still gets an identity
  });
});

describe("avatar logic (pure)", () => {
  it("maps hook status and activity onto the nine avatar states", () => {
    expect(avatarState("idle")).toBe("idle");
    expect(avatarState("waiting")).toBe("listening");
    expect(avatarState("blocked")).toBe("blocked");
    expect(avatarState("done")).toBe("done");
    expect(avatarState("working")).toBe("implementing");
    expect(avatarState("working", "planning")).toBe("planning");
    expect(avatarState("working", "nonsense")).toBe("implementing");
    expect(avatarState("idle", "debugging")).toBe("idle");
  });

  it("maps states to orbs per the spec", () => {
    expect(orbMode("planning")).toBe("shaping");
    expect(orbMode("exploring")).toBe("searching");
    expect(orbMode("implementing")).toBe("working");
    expect(orbMode("debugging")).toBe("solving");
    expect(orbMode("composing")).toBe("composing");
    expect(orbMode("listening")).toBe("listening");
    expect(orbMode("idle")).toBe("still");
  });

  it("prefers unused shapes and colours", () => {
    expect(pickIdentity([])).toEqual({ shape: "circle", color: "#0A84FF" });
    expect(pickIdentity([{ shape: "circle", color: "#0A84FF" }])).toEqual({ shape: "egg", color: "#FF6A00" });
  });
});
