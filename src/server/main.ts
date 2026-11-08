import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { startDaemon } from "./daemon.ts";
import { createFakeAgentRunner } from "./fake-agent.ts";
import { createPtyAgentRunner } from "./pty-agent.ts";
import { resolveSandbox } from "./sbx.ts";
import { createGitHubCli } from "./github.ts";
import { createClaudeReviewer } from "./reviewer.ts";
import { discoverPocockSkills } from "./workspace.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const port = Number(process.env.BRIDGE_PORT ?? 4317);
const dataDir = process.env.BRIDGE_DATA_DIR ?? join(homedir(), ".bridge");

// Set BRIDGE_FAKE_AGENT=1 for the scripted fake. Otherwise use Docker Sandboxes when sbx works, else local mode.
const fake = !!process.env.BRIDGE_FAKE_AGENT;
const local = fake
  ? createFakeAgentRunner([{ type: "status", status: "working" }, { type: "status", status: "done" }])
  : createPtyAgentRunner();
const sandbox = fake
  ? { mode: "local" as const, runner: local, networkRules: undefined, notice: "Fake agent: no sandbox." }
  : await resolveSandbox({ local });
console.log(sandbox.notice);

const daemon = await startDaemon({
  dataDir, port, skills: discoverPocockSkills(), webDir: join(root, "dist", "web"),
  runner: sandbox.runner, mode: sandbox.mode, networkRules: sandbox.networkRules, sandboxNotice: sandbox.notice,
  github: fake ? undefined : createGitHubCli(),
  reviewer: fake ? undefined : createClaudeReviewer(),
  agentHost: sandbox.mode === "sandbox" ? "host.docker.internal" : undefined,
});
console.log(`Bridge listening on ${daemon.url}`);
const quit = () => daemon.close().then(() => process.exit(0));
process.on("SIGINT", quit);
process.on("SIGTERM", quit);
