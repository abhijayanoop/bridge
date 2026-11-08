import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join, normalize, resolve } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import type { AgentEvent, AgentRunner, AgentStatus } from "./agent-runner.ts";
import { DEFAULT_WORKSPACE, openStore, type AgentRow, type Project } from "./db.ts";
import { HOOK_STATUSES, activityForTool, ACTIVITIES, pickIdentity } from "../shared/avatar.ts";
import { writeHookConfig, writeMcpConfig } from "./hooks.ts";
import { handleAgentTools } from "./agent-tools.ts";
import { createInbox } from "./inbox.ts";
import { SCOPES, createApprovals, isMergeCommand, type NetworkRules } from "./approvals.ts";
import { createWorkspaces, type Mode, type SkillSource, type Workspace } from "./workspace.ts";
import type { GitHub } from "./github.ts";
import { createPullRaiser } from "./pull-requests.ts";
import { COLUMNS, moveTicket, readTickets, watchTickets, type Ticket } from "./tickets.ts";

/** Workers that may run at once: 2 by default, raisable to 3 (the Pro plan's limits make more costly). */
export const DEFAULT_CAP = 2;
export const MAX_CAP = 3;
/** What an agent's terminal prints when the plan's usage limit is hit. Narrow on purpose: code that merely mentions rate limits must not pause the queue. */
const RATE_LIMIT_TEXT = /usage limit reached|(?:5-hour|weekly|session|rate) limit reached|hit your (?:\w+ )?limit/i;

interface Queued { id: string; projectId: string; name: string; ticketId: string; ticketKey: string; ticketTitle: string }

export interface DaemonOptions {
  dataDir: string;
  runner: AgentRunner;
  /** 0 picks a free port. */
  port?: number;
  /** Directory of the built UI; omitted means API only. */
  webDir?: string;
  /** The sandbox's network allow-list that Bridge-approved domains are added to. Defaults to a no-op. */
  networkRules?: NetworkRules;
  /** `local` (default) runs without a sandbox and keeps permission prompts on. */
  mode?: Mode;
  /** Skills copied into every ticket clone (the user's installed Pocock skills). */
  skills?: SkillSource[];
  /** Why this mode was chosen (e.g. sbx missing, so local mode); served at /api/sandbox. */
  sandboxNotice?: string;
  /** Host name agents use to reach this daemon in hook and MCP URLs. Sandboxes need `host.docker.internal`. */
  agentHost?: string;
  /** Opens a pull request when an agent finishes a ticket. Omitted means no pull requests (tests, fake agent). */
  github?: GitHub;
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

/**
 * The agent's first prompt. One line, because it travels as a command-line argument. Names the Bridge tools,
 * since the agent will not use them unless told, and asks it to tick finished acceptance boxes in its ticket file.
 */
export function taskFor(ticket: { key: string; title: string; file: string }): string {
  return [
    `Work on ticket ${ticket.key}: ${ticket.title}.`,
    `Read the ticket file ${ticket.file} first (or call the Bridge tool get_my_ticket).`,
    `Use the Bridge tools: set_my_status to "working" when you start and "done" when every acceptance box is met; ask_user for a question only the user can answer; request_access for a network domain, secret or push you need.`,
    `As you meet each acceptance box, change "- [ ]" to "- [x]" in the ticket file and commit that with your work on the current branch.`,
    `Never merge: the user merges.`,
  ].join(" ");
}

export async function startDaemon(opts: DaemonOptions) {
  const store = openStore(opts.dataDir);
  const sockets = new Set<WebSocket>();
  const broadcast = (msg: unknown) => {
    const text = JSON.stringify(msg);
    for (const s of sockets) if (s.readyState === s.OPEN) s.send(text);
  };

  const inbox = createInbox(store, (item, open) => broadcast({ type: "inbox", item, open }));

  const mode: Mode = opts.mode ?? "local";
  const workspaces = createWorkspaces({ clonesDir: join(opts.dataDir, "clones"), skills: opts.skills });

  const approvals = createApprovals(store, opts.networkRules ?? { add: () => true, remove: () => {} });

  /** Per-agent secret that lets an agent's hooks report status; never listed by the API. */
  const hookTokens = new Map<string, string>();
  let port = 0;
  const agentHost = opts.agentHost ?? "127.0.0.1";

  /** Branch each agent was started on, and the agents already told where their branch went. */
  const agentBranch = new Map<string, string>();
  const announced = new Set<string>();
  /**
   * Makes an agent's branch available in the user's own repo (a fetch from its clone), at idle, done, stop and
   * delete. Tells the agent's terminal once where to find it.
   */
  const publishBranch = (agentId: string): string | null => {
    const a = store.agent(agentId);
    const project = a && store.projects().find((p) => p.id === a.projectId);
    if (!a || !project) return null;
    const branch = workspaces.publish(agentId, project.path, agentBranch.get(agentId));
    if (!branch) return null;
    agentBranch.set(agentId, branch);
    if (announced.has(agentId)) return branch;
    announced.add(agentId);
    const event: AgentEvent = { type: "output", data: `
[Bridge] Branch ${branch} is now in your repo. Review it with: git log ${branch}
` };
    broadcast({ type: "agent-event", agentId, eventId: store.addEvent(agentId, event), event });
    return branch;
  };

  const pulls = createPullRaiser({
    github: opts.github,
    agent: (id) => store.agent(id),
    project: (id) => store.projects().find((p) => p.id === id),
    ticket: (project, ticketId) => readTickets(project.path, project.id).find((t) => t.id === ticketId),
    fileAt: (path, branch, file) => workspaces.fileAt(path, branch, file),
    pulls: () => store.pulls(),
    addPull: (p) => store.addPull(p),
    say: (agentId, text) => {
      const event: AgentEvent = { type: "output", data: `\r\n[Bridge] ${text}\r\n` };
      broadcast({ type: "agent-event", agentId, eventId: store.addEvent(agentId, event), event });
    },
    broadcast,
  });
  /** An agent finished its ticket: publish its branch, open its pull request, and give its slot to the queue. */
  const onDone = (agentId: string) => { const branch = publishBranch(agentId); if (branch) pulls.raise(agentId, branch); drain(); };

  const watchers = new Map<string, () => void>();
  /** Pushes a "tickets" message when files under the repo's .scratch change. */
  const watchProject = (p: Project) => {
    if (watchers.has(p.id)) return;
    const stop = watchTickets(p.path, () => { broadcast({ type: "tickets", projectId: p.id }); drain(); });
    if (stop) watchers.set(p.id, stop);
  };

  const send = (res: ServerResponse, code: number, body: unknown) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };

  // Worker cap and queue. Only ticket workers count; the lead and ticketless agents are free.
  const cap = () => {
    const n = Number(store.setting("workerCap"));
    return Number.isInteger(n) && n >= 1 && n <= MAX_CAP ? n : DEFAULT_CAP;
  };
  const running = () => store.agents().filter((a) => a.ticketId && !a.lead && a.status !== "done").length;
  const queue: Queued[] = [];
  /** Set when an agent reports the plan's usage limit; the queue stays paused until the user resumes it. */
  let rateLimit: { since: number; agentId: string } | null = null;
  const ticketOf = (q: Queued) => {
    const project = store.projects().find((p) => p.id === q.projectId);
    return { project, ticket: project ? readTickets(project.path, project.id).find((t) => t.id === q.ticketId) : undefined };
  };
  const limitsView = () => ({
    cap: cap(), max: MAX_CAP, running: running(),
    rateLimited: rateLimit,
    queued: queue.map((q) => ({ ...q, blocked: ticketOf(q).ticket?.blocked ?? false })),
  });
  const limitsChanged = () => broadcast({ type: "limits", limits: limitsView() });
  /** Starts queued tickets, oldest first, while there is a free slot, no rate limit and no unmet blocker. */
  function drain() {
    for (let i = 0; i < queue.length && !rateLimit && running() < cap();) {
      const q = queue[i]!;
      const { project, ticket } = ticketOf(q);
      if (!project || !ticket) { queue.splice(i, 1); continue; }
      if (ticket.blocked) { i++; continue; }
      queue.splice(i, 1);
      spawn(project, q.name, ticket, false);
    }
    limitsChanged();
  }

  /** Creates the agent (and its clone, for a ticket) and starts it. */
  const spawn = (project: Project, name: string, ticket: Ticket | undefined, lead: boolean): { code: number; body: unknown } => {
    const projectId = project.id;
    const identity = pickIdentity(store.agents().filter((a) => a.projectId === projectId && a.shape && a.color).map((a) => ({ shape: a.shape as any, color: a.color! })));
    const agent: AgentRow = { id: randomUUID(), projectId, name, status: "idle", ticketId: ticket?.id ?? null, ticketKey: ticket?.key ?? null, ticketTitle: ticket?.title ?? null, ...identity, lead };
    let workspace: Workspace | null = null;
    if (ticket) {
      try { workspace = workspaces.prepare({ agentId: agent.id, projectPath: project.path, ticketFile: ticket.file, ticketKey: ticket.key }); }
      catch (err) { return { code: 500, body: { error: `could not create clone: ${(err as Error).message}` } }; }
    }
    const cwd = workspace?.path ?? project.path;
    const task = ticket ? taskFor(ticket) : undefined;
    store.addAgent(agent);
    if (workspace) agentBranch.set(agent.id, workspace.branch);
    const token = randomUUID();
    hookTokens.set(agent.id, token);
    const hook = { url: `http://${agentHost}:${port}/api/agents/${agent.id}/hook`, token };
    try { if (existsSync(cwd)) writeHookConfig(cwd, hook.url, token, mode === "sandbox" ? "sh" : "node"); } catch { /* workspace not writable: status falls back to runner events */ }
    broadcast({ type: "agent", agent: store.agent(agent.id) });
    let mcpConfig: string | undefined;
    try { if (existsSync(cwd)) mcpConfig = writeMcpConfig(cwd, agent.id, `http://${agentHost}:${port}/mcp/${agent.id}`, token); } catch { /* workspace not writable */ }
    opts.runner.start({ id: agent.id, name, projectId, cwd, task, hook, mcpConfig, mode, permissionPrompts: mode === "local" || !workspace, env: workspace?.env },(event: AgentEvent) => {
      const eventId = store.addEvent(agent.id, event);
      if (event.type === "output" && !rateLimit && RATE_LIMIT_TEXT.test(event.data)) { rateLimit = { since: Date.now(), agentId: agent.id }; limitsChanged(); }
      if (event.type === "status") { store.setStatus(agent.id, event.status); broadcast({ type: "agent", agent: store.agent(agent.id) }); if (event.status === "done") onDone(agent.id); else if (event.status === "idle") publishBranch(agent.id); }
      broadcast({ type: "agent-event", agentId: agent.id, eventId, event });
    });
    return { code: 201, body: { ...store.agent(agent.id), workspace: { path: cwd, branch: workspace?.branch ?? null, mode } } };
  };

  async function api(req: IncomingMessage, res: ServerResponse, path: string) {
    const method = req.method ?? "GET";
    if (path === "/api/health") return send(res, 200, { ok: true });
    if (path === "/api/pulls") return send(res, 200, store.pulls());
    if (path === "/api/limits" && method === "GET") return send(res, 200, limitsView());
    if (path === "/api/limits" && method === "POST") {
      const { cap: wanted } = await readJson(req);
      if (!Number.isInteger(wanted) || wanted < 1 || wanted > MAX_CAP) return send(res, 400, { error: `cap must be a whole number from 1 to ${MAX_CAP}` });
      store.setSetting("workerCap", String(wanted));
      drain();
      return send(res, 200, limitsView());
    }
    if (path === "/api/limits/resume" && method === "POST") {
      rateLimit = null;
      drain();
      return send(res, 200, limitsView());
    }
    if (path === "/api/sandbox") return send(res, 200, { mode, message: opts.sandboxNotice ?? "" });
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
      watchProject(project);
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
      if (pm[2] === "tickets" && method === "GET") {
        watchProject(project);
        return send(res, 200, readTickets(project.path, project.id));
      }
    }
    const tm = path.match(/^\/api\/projects\/([^/]+)\/tickets\/status$/);
    if (tm && method === "POST") {
      const project = store.projects().find((p) => p.id === tm[1]);
      if (!project) return send(res, 404, { error: "unknown project" });
      const { ticket: id, column } = await readJson(req);
      if (!(COLUMNS as readonly string[]).includes(column)) return send(res, 400, { error: "unknown column" });
      const ticket = moveTicket(project.path, project.id, String(id), column);
      if (!ticket) return send(res, 404, { error: "unknown ticket" });
      broadcast({ type: "tickets", projectId: project.id });
      drain();
      return send(res, 200, ticket);
    }
    if (path === "/api/agents" && method === "GET") return send(res, 200, store.agents());
    if (path === "/api/agents" && method === "POST") {
      const body = await readJson(req);
      const { projectId, name, ticket: ticketId } = body;
      const project = store.projects().find((p) => p.id === projectId);
      if (!project) return send(res, 404, { error: "unknown project" });
      if (!name) return send(res, 400, { error: "name required" });
      const ticket = ticketId ? readTickets(project.path, project.id).find((t) => t.id === ticketId) : undefined;
      if (ticketId && !ticket) return send(res, 404, { error: "unknown ticket" });
      const lead = body.lead === true;
      if (ticket && !lead && (rateLimit || running() >= cap() || ticket.blocked)) {
        const entry: Queued = { id: randomUUID(), projectId: project.id, name, ticketId: ticket.id, ticketKey: ticket.key, ticketTitle: ticket.title };
        queue.push(entry);
        limitsChanged();
        return send(res, 202, { queued: true, id: entry.id, position: queue.length });
      }
      const r = spawn(project, name, ticket, lead);
      return send(res, r.code, r.body);
    }
    if (path === "/api/inbox" && method === "GET") return send(res, 200, { items: inbox.list(), open: inbox.open() });
    const im = path.match(/^\/api\/inbox\/([^/]+)\/resolve$/);
    if (im && method === "POST") {
      const { decision, text, scope = "once" } = await readJson(req);
      if (!["approve", "deny", "reply"].includes(decision)) return send(res, 400, { error: "unknown decision" });
      if (decision === "reply" && (typeof text !== "string" || !text.trim())) return send(res, 400, { error: "reply text required" });
      if (!(SCOPES as readonly string[]).includes(scope)) return send(res, 400, { error: "unknown scope" });
      const open = store.inboxItem(im[1]!);
      const grants = decision === "approve" && open?.status === "open" && open.kind === "access";
      if (grants && scope === "ticket" && !open.ticketKey) return send(res, 400, { error: "this agent has no ticket" });
      const item = inbox.resolve(im[1]!, { decision, reply: typeof text === "string" && text ? text : undefined });
      if (item && grants) approvals.grant(item, scope);
      return item ? send(res, 200, item) : send(res, 404, { error: "unknown or already resolved" });
    }
    if (path === "/api/approvals" && method === "GET") return send(res, 200, approvals.list());
    const am = path.match(/^\/api\/approvals\/([^/]+)$/);
    if (am && method === "DELETE") {
      const a = approvals.revoke(am[1]!);
      return a ? send(res, 200, a) : send(res, 404, { error: "unknown or already undone" });
    }
    const dm = path.match(/^\/api\/agents\/([^/]+)$/);
    if (dm && method === "DELETE") {
      const a = store.agent(dm[1]!);
      if (!a) return send(res, 404, { error: "unknown agent" });
      pulls.userStopped(a.id);
      opts.runner.stop(a.id);
      publishBranch(a.id);
      pulls.forget(a.id);
      agentBranch.delete(a.id); announced.delete(a.id);
      hookTokens.delete(a.id);
      store.deleteAgent(a.id);
      try { workspaces.remove(a.id); } catch { /* clone already gone */ }
      broadcast({ type: "agent-deleted", agentId: a.id });
      drain();
      return send(res, 200, { ok: true });
    }
    const hm = path.match(/^\/api\/agents\/([^/]+)\/hook$/);
    if (hm && method === "POST") {
      const expected = hookTokens.get(hm[1]!);
      if (!expected || req.headers["x-bridge-token"] !== expected) return send(res, 401, { error: "invalid token" });
      const body = await readJson(req);
      // Sandbox hooks (no Node there) post Claude's raw hook input with status and activity in the query string.
      const q = new URL(req.url ?? "/", "http://x").searchParams;
      const status = q.get("status") ?? body.status;
      const activity = q.get("activity") || body.activity;
      const tool = body.tool ?? body.tool_name;
      const command = body.command ?? body.tool_input?.command;
      if (tool === "Bash" && typeof command === "string" && isMergeCommand(command)) {
        return send(res, 403, { error: "Bridge refused this command: agents may never merge. Push your branch and open a pull request; the user merges." });
      }
      if (!(HOOK_STATUSES as readonly string[]).includes(status)) return send(res, 400, { error: "unknown status" });
      const act = (ACTIVITIES as readonly string[]).includes(activity) ? activity : activityForTool(tool, command);
      const ev: AgentEvent = { type: "status", status };
      const prev = store.agent(hm[1]!);
      if (!prev) return send(res, 404, { error: "unknown agent" });
      // A tool call or prompt while blocked/waiting means the agent resumed; a done agent stays done.
      if (prev.status === "done") return send(res, 200, { ok: true, ignored: true });
      store.setStatus(prev.id, status, act);
      const eventId = store.addEvent(prev.id, ev);
      const agent = store.agent(prev.id);
      broadcast({ type: "agent", agent });
      broadcast({ type: "agent-event", agentId: prev.id, eventId, event: ev });
      if (status === "done") onDone(prev.id); else if (status === "idle") publishBranch(prev.id);
      return send(res, 200, agent);
    }
    const m = path.match(/^\/api\/agents\/([^/]+)\/(events|stop)$/);
    if (m) {
      if (m[2] === "events" && method === "GET") return send(res, 200, store.events(m[1]!));
      if (m[2] === "stop" && method === "POST") {
        const a = store.agents().find((x) => x.id === m[1]);
        if (!a) return send(res, 404, { error: "unknown agent" });
        pulls.userStopped(a.id);
        opts.runner.stop(a.id);
        if (a.status !== "done") {
          const ev: AgentEvent = { type: "status", status: "done" };
          store.setStatus(a.id, "done");
          broadcast({ type: "agent-event", agentId: a.id, eventId: store.addEvent(a.id, ev), event: ev });
        }
        publishBranch(a.id);
        drain();
        return send(res, 200, { ok: true });
      }
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
    const mm = path.match(/^\/mcp\/([^/]+)$/);
    if (mm) {
      const id = mm[1]!;
      const agent = store.agent(id);
      const expected = hookTokens.get(id);
      if (!agent || !expected || req.headers["x-bridge-token"] !== expected) return send(res, 401, { error: "invalid token" });
      const project = store.projects().find((p) => p.id === agent.projectId);
      const setStatus = (status: AgentStatus) => {
        store.setStatus(id, status);
        const ev: AgentEvent = { type: "status", status };
        const eventId = store.addEvent(id, ev);
        broadcast({ type: "agent", agent: store.agent(id) });
        broadcast({ type: "agent-event", agentId: id, eventId, event: ev });
      };
      handleAgentTools({
        ticket: () => {
          const t = project && agent.ticketId ? readTickets(project.path, project.id).find((x) => x.id === agent.ticketId) : undefined;
          if (!t || !project) return null;
          let body = "";
          try { body = readFileSync(join(project.path, t.file), "utf8"); } catch { /* file gone */ }
          return { key: t.key, title: t.title, status: t.status, blockers: t.blockers, file: t.file, body };
        },
        setStatus: (s) => { if (store.agent(id)?.status !== "done") { setStatus(s); if (s === "done") onDone(id); } },
        async requestAccess(kind, detail, item) {
          if (approvals.covering(agent.projectId, agent.ticketKey ?? null, kind, detail)) return { decision: "approve" };
          return this.raise(item);
        },
        async raise(item) {
          const { answer } = inbox.raise({ ...item, agentId: id, projectId: agent.projectId, ticketKey: agent.ticketKey });
          setStatus("blocked");
          const a = await answer;
          if (store.agent(id)?.status === "blocked") setStatus("working");
          return a;
        },
      }, req, res).catch(() => { if (!res.headersSent) send(res, 500, { error: "internal error" }); });
      return;
    }
    const run = path.startsWith("/api/") ? api(req, res, path) : Promise.resolve(serveStatic(res, path));
    run.catch(() => send(res, 500, { error: "internal error" }));
  });
  const wss = new WebSocketServer({ server, path: "/ws" });
  wss.on("connection", (ws) => {
    sockets.add(ws);
    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(String(raw));
        if (msg.type === "input" && typeof msg.agentId === "string" && typeof msg.data === "string") opts.runner.write(msg.agentId, msg.data);
        if (msg.type === "resize" && typeof msg.agentId === "string") opts.runner.resize?.(msg.agentId, Number(msg.cols), Number(msg.rows));
      } catch { /* ignore malformed */ }
    });
    ws.on("close", () => sockets.delete(ws));
  });

  await new Promise<void>((r) => server.listen(opts.port ?? 0, "127.0.0.1", r));
  const addr = server.address();
  port = typeof addr === "object" && addr ? addr.port : 0;

  return {
    port,
    url: `http://127.0.0.1:${port}`,
    async close() {
      for (const stop of watchers.values()) stop();
      for (const s of sockets) s.terminate();
      server.closeAllConnections();
      wss.close();
      await new Promise<void>((r) => server.close(() => r()));
      store.close();
    },
  };
}
