#!/usr/bin/env node
// Starts the Bridge daemon (or reuses a running one) and opens the browser.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.BRIDGE_PORT ?? 4317);
const url = `http://127.0.0.1:${port}`;

async function healthy() {
  try {
    const r = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(800) });
    return r.ok;
  } catch { return false; }
}

if (await healthy()) {
  console.log(`Bridge already running at ${url}`);
} else {
  const child = spawn(process.execPath, [join(root, "src/server/main.ts")], {
    detached: true, stdio: "ignore", windowsHide: true, env: process.env,
  });
  child.unref();
  for (let i = 0; i < 50 && !(await healthy()); i++) await new Promise((r) => setTimeout(r, 100));
  if (!(await healthy())) { console.error("Bridge daemon did not start."); process.exit(1); }
  console.log(`Bridge started at ${url}`);
}

if (!process.argv.includes("--no-open")) {
  const [cmd, args] = process.platform === "win32" ? ["cmd", ["/c", "start", "", url]]
    : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  spawn(cmd, args, { detached: true, stdio: "ignore" }).unref();
}
