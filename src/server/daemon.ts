import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join, normalize, resolve } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import type { AgentEvent, AgentRunner } from "./agent-runner.ts";
import { DEFAULT_WORKSPACE, openStore } from "./db.ts";

export interface DaemonOptions {
  dataDir: string;
  runner: AgentRunner;
  /** 0 picks a free port. */
  port?: number;
  /** Directory of the built UI; omitted means API only. */
  webDir?: string;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css",
  ".svg": "image/svg+xml", ".json": "application/json", ".woff2": "font/woff2",
};

async function readJson(req: IncomingMessage): Promise<any> {
  let body = "";
  for await (const chunk of req) body += chunk;
  return body ? JSON.parse(body) : {};
}

export async function startDaemon(opts: DaemonOptions) {
  const store = openStore(opts.dataDir);
  const sockets = new Set<WebSocket>();
  const broadcast = (msg: unknown) => {
    const text = JSON.stringify(msg);
    for (const s of sockets) if (s.readyState === s.OPEN) s.send(text);
  };

  const send = (res: ServerResponse, code: number, body: unknown) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };

  async function api(req: IncomingMessage, res: ServerResponse, path: string) {
    const method = req.method ?? "GET";
    if (path === "/api/health") return send(res, 200, { ok: true });
    if (path === "/api/projects" && method === "GET") return send(res, 200, store.projects());
    if (path === "/api/projects" && method === "POST") {
      const { name, path: repoPath } = await readJson(req);
      if (!name || !repoPath) return send(res, 400, { error: "name and path required" });
      const project = { id: randomUUID(), name, path: repoPath };
      store.addProject(project);
      broadcast({ type: "project", project });
      return send(res, 201, project);
    }
    if (path === "/api/workspaces" && method === "GET") return send(res, 200, store.workspaces());
    if (path === "/api/active-project" && method === "GET") {
      const id = store.activeProjectId();
      return send(res, 200, store.projects().find((p) => p.id === id) ?? { id: null });
    }
    if (path === "/api/projects/open" && method === "POST") {
      const { path: given } = await readJson(req);
      if (typeof given !== "string" || !given) return send(res, 400, { error: "path required" });
      const abs = resolve(given);
      if (!existsSync(abs) || !statSync(abs).isDirectory()) return send(res, 400, { error: "not a directory" });
      const key = (p: string) => (process.platform === "win32" ? p.toLowerCase() : p);
      let project = store.projects().find((p) => key(p.path) === key(abs));
      const created = !project;
      if (!project) {
        project = { id: randomUUID(), name: basename(abs) || abs, path: abs, workspaceId: DEFAULT_WORKSPACE };
        store.addProject(project);
        broadcast({ type: "project", project });
      }
      store.setActiveProject(project.id);
      broadcast({ type: "active-project", projectId: project.id });
      return send(res, created ? 201 : 200, project);
    }
    const pm = path.match(/^\/api\/projects\/([^/]+)\/(select|tickets)$/);
    if (pm) {
      const project = store.projects().find((p) => p.id === pm[1]);
      if (!project) return send(res, 404, { error: "unknown project" });
      if (pm[2] === "select" && method === "POST") {
        store.setActiveProject(project.id);
        broadcast({ type: "active-project", projectId: project.id });
        return send(res, 200, project);
      }
      if (pm[2] === "tickets" && method === "GET") return send(res, 200, store.tickets(project.id));
      if (pm[2] === "tickets" && method === "POST") {
        const { key, title } = await readJson(req);
        if (!key || !title) return send(res, 400, { error: "key and title required" });
        const ticket = { id: randomUUID(), repoId: project.id, key, title };
        store.addTicket(ticket);
        return send(res, 201, ticket);
      }
    }
    if (path === "/api/agents" && method === "GET") return send(res, 200, store.agents());
    if (path === "/api/agents" && method === "POST") {
      const { projectId, name } = await readJson(req);
      if (!store.projects().some((p) => p.id === projectId)) return send(res, 404, { error: "unknown project" });
      if (!name) return send(res, 400, { error: "name required" });
      const agent = { id: randomUUID(), projectId, name, status: "idle" as const };
      store.addAgent(agent);
      broadcast({ type: "agent", agent });
      opts.runner.start({ id: agent.id, name, projectId }, (event: AgentEvent) => {
        store.addEvent(agent.id, event);
        if (event.type === "status") store.setStatus(agent.id, event.status);
        broadcast({ type: "agent-event", agentId: agent.id, event });
      });
      return send(res, 201, agent);
    }
    const m = path.match(/^\/api\/agents\/([^/]+)\/(events|stop)$/);
    if (m) {
      if (m[2] === "events" && method === "GET") return send(res, 200, store.events(m[1]!));
      if (m[2] === "stop" && method === "POST") { opts.runner.stop(m[1]!); return send(res, 200, { ok: true }); }
    }
    return send(res, 404, { error: "not found" });
  }

  function serveStatic(res: ServerResponse, path: string) {
    const root = opts.webDir;
    if (!root || !existsSync(join(root, "index.html"))) {
      res.writeHead(503, { "content-type": "text/plain" });
      return res.end("Bridge UI is not built. Run npm run build.");
    }
    const rel = normalize(path).replace(/^([/\\])+/, "");
    let file = join(root, rel);
    if (rel.includes("..") || rel === "" || !existsSync(file)) file = join(root, "index.html");
    res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
    res.end(readFileSync(file));
  }

  const server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    const run = path.startsWith("/api/") ? api(req, res, path) : Promise.resolve(serveStatic(res, path));
    run.catch(() => send(res, 500, { error: "internal error" }));
  });
  const wss = new WebSocketServer({ server, path: "/ws" });
  wss.on("connection", (ws) => {
    sockets.add(ws);
    ws.on("close", () => sockets.delete(ws));
  });

  await new Promise<void>((r) => server.listen(opts.port ?? 0, "127.0.0.1", r));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;

  return {
    port,
    url: `http://127.0.0.1:${port}`,
    async close() {
      for (const s of sockets) s.terminate();
      wss.close();
      await new Promise<void>((r) => server.close(() => r()));
      store.close();
    },
  };
}
