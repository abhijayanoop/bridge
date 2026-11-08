#!/usr/bin/env node
// Dev mode: the daemon restarts when a server file changes (node --watch), and the UI is served by
// Vite with hot reload and proxies /api and /ws to the daemon. Ctrl+C stops both.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const vite = join(root, "node_modules", "vite", "bin", "vite.js");

const run = (name, args) => {
  const child = spawn(process.execPath, args, { cwd: root, stdio: "inherit", env: process.env });
  child.on("exit", (code) => { console.log(`[dev] ${name} exited (${code ?? "signal"})`); stop(); });
  return child;
};

const children = [
  run("daemon", ["--watch", "--watch-preserve-output", join(root, "src/server/main.ts")]),
  run("ui", [vite]),
];
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  for (const c of children) c.kill();
  setTimeout(() => process.exit(0), 300);
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
console.log("[dev] daemon on http://127.0.0.1:4317 (restarts on server changes); open the UI at the Vite URL below (usually http://localhost:5173).");
