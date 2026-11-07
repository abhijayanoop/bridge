import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { startDaemon } from "./daemon.ts";
import { createFakeAgentRunner } from "./fake-agent.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const port = Number(process.env.BRIDGE_PORT ?? 4317);
const dataDir = process.env.BRIDGE_DATA_DIR ?? join(homedir(), ".bridge");

// Walking skeleton: only the scripted fake agent exists until real adapters land.
const daemon = await startDaemon({
  dataDir, port, webDir: join(root, "dist", "web"),
  runner: createFakeAgentRunner([
    { type: "status", status: "working" },
    { type: "status", status: "done" },
  ]),
});
console.log(`Bridge listening on ${daemon.url}`);
const quit = () => daemon.close().then(() => process.exit(0));
process.on("SIGINT", quit);
process.on("SIGTERM", quit);
