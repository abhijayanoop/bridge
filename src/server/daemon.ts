import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join, normalize, resolve } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import type { AgentEvent, AgentRunner, AgentStatus } from "./agent-runner.ts";
import { DEFAULT_WORKSPACE, openStore, type AgentRow, type Project } from "./db.ts";
import { HOOK_STATUSES, activityForTool, ACTIVITIES, pickIdentity } from "../shared/avatar.ts";
import { writeHookConfig, writeMcpConfig } from "./hooks.ts";
import { handleAgentTools, type AgentToolContext } from "./agent-tools.ts";
import { createConnections } from "./connections.ts";
import { CONNECTION_KINDS, checkReadOnly, scrub, withoutValues, type ConnectionKind, type DataSource } from "./datasource.ts";
import { maskRows } from "./masking.ts";
import { roleSetupSteps, validIdentifier } from "./analyst-setup.ts";
import { createInbox, type Answer } from "./inbox.ts";
import { SCOPES, createApprovals, isMergeCommand, type NetworkRules } from "./approvals.ts";
import { createWorkspaces, type Mode, type SkillSource, type Workspace } from "./workspace.ts";
import type { GitHub } from "./github.ts";
import { createPullRaiser } from "./pull-requests.ts";
import { checkLook, createFeatures, leadTask, type Feature } from "./features.ts";
import { QUICK_ACTIONS, analystTask, quickActionTask, retroTask } from "./quick-actions.ts";
import { createReviewStage } from "./review-stage.ts";
import type { Reviewer } from "./reviewer.ts";
import { TRACKERS, isConfigured, isFreeTarget, newProjectSteps, runSetup, scaffoldProject, validProjectName, type Tracker } from "./setup.ts";
import { COLUMNS, moveTicket, readTickets, watchTickets, type Ticket } from "./tickets.ts";

/** Workers that may run at once: 2 by default, raisable to 3 (the Pro plan's limits make more costly). */
export const DEFAULT_CAP = 2;
export const MAX_CAP = 3;
/** What an agent's terminal prints when the plan's usage limit is hit. Narrow on purpose: code that merely mentions rate limits must not pause the queue. */
const RATE_LIMIT_TEXT = /usage limit reached|(?:5-hour|weekly|session|rate) limit reached|hit your (?:\w+ )?limit/i;

interface Queued { id: string; projectId: string; name: string; ticketId: string; ticketKey: string; ticketTitle: string;
  /** Why starting it failed (e.g. the clone). It stays queued and is retried when the user resumes. */
  error?: string }

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
  /** Reviews a finished branch for standards and spec before its pull request opens. Omitted means no review stage. */
  reviewer?: Reviewer;
  /** How often open pull requests are checked on GitHub, in ms. Default 30 seconds; 0 turns polling off. */
  pullPollMs?: number;
  /** Reads the user's real databases for the Analyst, on the host. Omitted means no driver: connections cannot be tested or queried. */
  dataSource?: DataSource;
  /** Called after the UI confirmed quitting (POST /api/quit). Omitted means the request only answers; the process keeps running. */
  onQuit?: () => void;
}

/** What closing the daemon did to the agents that were still running. */
export interface ExitReport {
  stopped: { id: string; name: string; ticketKey: string | null }[];
  failed: { id: string; name: string; ticketKey: string | null; error: string }[];
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

  const features = createFeatures(store);
  const inbox = createInbox(store, (item, open) => broadcast({ type: "inbox", item, open }));

  const mode: Mode = opts.mode ?? "local";
  const workspaces = createWorkspaces({ clonesDir: join(opts.dataDir, "clones"), skills: opts.skills });

  const approvals = createApprovals(store, opts.networkRules ?? { add: () => true, remove: () => {} });
  const connections = createConnections(store, opts.dataDir);
  const noDriver = async (): Promise<never> => { throw new Error("no database driver is available in this build"); };
  const dataSource: DataSource = opts.dataSource ?? { datasets: noDriver, query: noDriver, writeAccess: noDriver };
  /** Largest result an Analyst query returns. */
  const ROW_LIMIT = 200;
  const analystReady = (projectId: string) => connections.list(projectId).some((c) => c.enabled);

  /** Per-agent secret that lets an agent's hooks report status; never listed by the API. */
  const hookTokens = new Map<string, string>();
  let port = 0;
  const agentHost = opts.agentHost ?? "127.0.0.1";
  /** Set while the daemon shuts down: agents dying then are interrupted, not finished. */
  let closing = false;
  /** Stops an agent's process. Returns why it could not, rather than throwing. */
  const stopRunner = (id: string): string | null => {
    try { opts.runner.stop(id); return null; } catch (e) { return (e as Error).message || "unknown error"; }
  };
  /** Agents whose process should be alive: started and not finished. */
  const liveAgents = () => store.agents().filter((a) => a.status !== "done");
  const brief = (a: AgentRow) => ({ id: a.id, name: a.name, ticketKey: a.ticketKey ?? null });
  const quitWarning = () => {
    const n = liveAgents().length;
    return n === 0 ? null : `${n} agent${n === 1 ? " is" : "s are"} still running. Quitting stops ${n === 1 ? "it" : "them"}; unfinished tickets resume the next time Bridge starts.`;
  };

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
    updatePull: (p) => store.updatePull(p),
    mergeLocal: (project, branch, title) => {
      // Ticket cards live as Status lines in the working copy; the merge puts them back, so re-apply every card's column.
      const columns = readTickets(project.path, project.id).map((t) => [t.id, t.column] as const);
      const r = workspaces.mergeLocal(project.path, branch, title);
      for (const [id, column] of columns) moveTicket(project.path, project.id, id, column);
      return r;
    },
    ticketByKey: (project, key) => readTickets(project.path, project.id).find((t) => t.key === key),
    say: (agentId, text) => {
      const event: AgentEvent = { type: "output", data: `\r\n[Bridge] ${text}\r\n` };
      broadcast({ type: "agent-event", agentId, eventId: store.addEvent(agentId, event), event });
    },
    broadcast,
    setColumn: (project, ticketId, column) => {
      if (moveTicket(project.path, project.id, ticketId, column)) broadcast({ type: "tickets", projectId: project.id });
    },
  });
  /** Each agent's clone and the commit it branched from, which the code review needs. */
  const agentCwd = new Map<string, string>();
  const agentBase = new Map<string, string>();
  // A review that was running when Bridge stopped will never report back.
  for (const r of store.reviews().filter((x) => x.status === "running")) {
    store.updateReview({ ...r, status: "failed", reason: "Bridge restarted during the review" });
  }
  const reviewStage = createReviewStage({
    reviewer: opts.reviewer,
    agent: (id) => store.agent(id),
    project: (id) => store.projects().find((p) => p.id === id),
    ticket: (project, ticketId) => readTickets(project.path, project.id).find((t) => t.id === ticketId),
    cwd: (id) => agentCwd.get(id),
    base: (id) => agentBase.get(id),
    stopped: (id) => pulls.wasStopped(id),
    reviews: () => store.reviews(),
    addReview: (r) => store.addReview(r),
    updateReview: (r) => store.updateReview(r),
    raise: (id, branch) => pulls.raise(id, branch),
    sendBack: (id, text) => {
      // The author goes back to work: its status flips so its next "done" is heard, and the findings are typed to it.
      const ev: AgentEvent = { type: "status", status: "working" };
      store.setStatus(id, "working");
      broadcast({ type: "agent", agent: store.agent(id) });
      broadcast({ type: "agent-event", agentId: id, eventId: store.addEvent(id, ev), event: ev });
      opts.runner.write(id, text + "\r");
    },
    say: (agentId, text) => {
      const event: AgentEvent = { type: "output", data: `\r\n[Bridge] ${text}\r\n` };
      broadcast({ type: "agent-event", agentId, eventId: store.addEvent(agentId, event), event });
    },
    broadcast,
    settled: () => drain(),
  });
  /** An agent finished its ticket: publish its branch, review it, then open its pull request; its slot goes to the queue. */
  const onDone = (agentId: string) => { const branch = publishBranch(agentId); if (branch) reviewStage.afterDone(agentId, branch); drain(); };

  /** Checks open pull requests on GitHub now and then, so cards move to Done when you merge on GitHub. */
  let polling = false;
  const pollTimer = opts.github && opts.pullPollMs !== 0
    ? setInterval(() => { if (polling) return; polling = true; void pulls.poll().catch(() => {}).finally(() => { polling = false; drain(); }); }, opts.pullPollMs ?? 30_000)
    : undefined;
  pollTimer?.unref();

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
  const running = () => store.agents().filter((a) => a.ticketId && !a.lead && (a.status !== "done" || reviewStage.busy(a.id))).length;
  const queue: Queued[] = [];
  try { queue.push(...(JSON.parse(store.setting("queue") ?? "[]") as Queued[])); } catch { /* unreadable: start with an empty queue */ }
  /** Set when an agent reports the plan's usage limit; the queue stays paused until the user resumes it. */
  let rateLimit: { since: number; agentId: string } | null = null;
  /** A ticket of a feature whose spec or ticket breakdown the user has not approved yet is never started. */
  const held = (projectId: string, ticket: Ticket) => features.holding(projectId, ticket);
  /** Per-project toggle: off by default. On, Bridge starts ready tickets itself instead of waiting for a Start click. */
  const autoDispatchOn = (projectId: string) => store.setting(`autoDispatch:${projectId}`) === "1";
  const ticketOf = (q: Queued) => {
    const project = store.projects().find((p) => p.id === q.projectId);
    return { project, ticket: project ? readTickets(project.path, project.id).find((t) => t.id === q.ticketId) : undefined };
  };
  const limitsView = () => ({
    cap: cap(), max: MAX_CAP, running: running(),
    rateLimited: rateLimit,
    queued: queue.map((q) => { const { project, ticket } = ticketOf(q); return { ...q, blocked: (ticket?.blocked ?? false) || (!!project && !!ticket && !!held(project.id, ticket)) }; }),
  });
  const limitsChanged = () => {
    // Every queue change passes here, so the queue is saved for the next launch.
    if (!closing) store.setSetting("queue", JSON.stringify(queue));
    broadcast({ type: "limits", limits: limitsView() });
  };
  /** True while a ticket already has a worker on it, in this project: started, still under review, or already in the queue. Ticket ids are unique only within a project, so projectId is part of the check. */
  const dispatched = (projectId: string, ticketId: string) =>
    store.agents().some((a) => a.projectId === projectId && a.ticketId === ticketId && (a.status !== "done" || reviewStage.busy(a.id))) ||
    queue.some((q) => q.projectId === projectId && q.ticketId === ticketId);
  const toQueued = (project: Project, ticket: Ticket, name: string): Queued =>
    ({ id: randomUUID(), projectId: project.id, name, ticketId: ticket.id, ticketKey: ticket.key, ticketTitle: ticket.title });
  /**
   * Queues every ready, unblocked ticket of a project with auto-dispatch on, exactly as a manual Start click would.
   * Idempotent: a ticket already dispatched (running, queued, or queued-with-error from a failed attempt) is skipped.
   */
  function autoEnqueue() {
    for (const project of store.projects()) {
      if (!autoDispatchOn(project.id)) continue;
      for (const ticket of readTickets(project.path, project.id)) {
        if (ticket.status !== "ready-for-agent" || ticket.blocked || held(project.id, ticket) || dispatched(project.id, ticket.id)) continue;
        queue.push(toQueued(project, ticket, ticket.title));
      }
    }
  }
  /** Starts queued tickets, oldest first, while there is a free slot, no rate limit and no unmet blocker. */
  function drain() {
    offerRetros();
    autoEnqueue();
    for (let i = 0; i < queue.length && !rateLimit && running() < cap();) {
      const q = queue[i]!;
      const { project, ticket } = ticketOf(q);
      if (!project || !ticket) { queue.splice(i, 1); continue; }
      if (ticket.blocked || q.error || held(project.id, ticket)) { i++; continue; }
      const r = spawn(project, q.name, ticket, false);
      if (r.code === 201) queue.splice(i, 1);
      else { q.error = String((r.body as { error?: string }).error ?? "could not start"); i++; }
    }
    limitsChanged();
  }

  const analystDir = (agentId: string) => { const d = join(opts.dataDir, "analyst", agentId); mkdirSync(d, { recursive: true }); return d; };

  /** Creates the agent (and its clone, for a ticket) and starts it. */
  const spawn = (project: Project, name: string, ticket: Ticket | undefined, lead: boolean, leadPrompt?: string, analyst = false): { code: number; body: unknown } => {
    const projectId = project.id;
    const look = ticket ? features.list(projectId).find((f) => f.slug === ticket.feature)?.looks[ticket.key] : undefined;
    const identity = analyst ? { shape: "cloud" as const, color: "#FF9500" } : look ?? pickIdentity(store.agents().filter((a) => a.projectId === projectId && a.shape && a.color).map((a) => ({ shape: a.shape as any, color: a.color! })));
    const agent: AgentRow = { id: randomUUID(), projectId, name, status: "idle", ticketId: ticket?.id ?? null, ticketKey: ticket?.key ?? null, ticketTitle: ticket?.title ?? null, ...identity, lead, analyst };
    let workspace: Workspace | null = null;
    if (ticket) {
      try { workspace = workspaces.prepare({ agentId: agent.id, projectPath: project.path, ticketFile: ticket.file, ticketKey: ticket.key }); }
      catch (err) { return { code: 500, body: { error: `could not create clone: ${(err as Error).message}` } }; }
    }
    // The Analyst works in an empty folder of its own: it has no ticket and no reason to touch the repo.
    const cwd = analyst ? analystDir(agent.id) : workspace?.path ?? project.path;
    const task = ticket ? taskFor(ticket) : leadPrompt;
    store.addAgent(agent);
    if (workspace) {
      agentBranch.set(agent.id, workspace.branch);
      agentCwd.set(agent.id, workspace.path);
      if (workspace.base) agentBase.set(agent.id, workspace.base);
      // Kept so the next launch finds this clone again.
      store.setSetting(`agentRun:${agent.id}`, JSON.stringify({ cwd: workspace.path, branch: workspace.branch, base: workspace.base }));
    }
    launch(agent, cwd, task, workspace?.env, !!workspace);
    return { code: 201, body: { ...store.agent(agent.id), workspace: { path: cwd, branch: workspace?.branch ?? null, mode } } };
  };

  /** Writes the agent's hook and tool config and starts its process. Used for new agents and for resumed ones. */
  function launch(agent: AgentRow, cwd: string, task: string | undefined, env: Record<string, string> | undefined, isolated: boolean) {
    const { name, projectId } = agent;
    const token = randomUUID();
    hookTokens.set(agent.id, token);
    const hook = { url: `http://${agentHost}:${port}/api/agents/${agent.id}/hook`, token };
    try { if (existsSync(cwd)) writeHookConfig(cwd, hook.url, token, mode === "sandbox" ? "sh" : "node"); } catch { /* workspace not writable: status falls back to runner events */ }
    broadcast({ type: "agent", agent: store.agent(agent.id) });
    let mcpConfig: string | undefined;
    try { if (existsSync(cwd)) mcpConfig = writeMcpConfig(cwd, agent.id, `http://${agentHost}:${port}/mcp/${agent.id}`, token); } catch { /* workspace not writable */ }
    opts.runner.start({ id: agent.id, name, projectId, cwd, task, hook, mcpConfig, mode, permissionPrompts: mode === "local" || !isolated, env },(event: AgentEvent) => {
      if (closing) return; // the process dying because Bridge is closing is not the agent finishing
      const eventId = store.addEvent(agent.id, event);
      if (event.type === "output" && !rateLimit && RATE_LIMIT_TEXT.test(event.data)) { rateLimit = { since: Date.now(), agentId: agent.id }; limitsChanged(); }
      if (event.type === "status") { store.setStatus(agent.id, event.status); broadcast({ type: "agent", agent: store.agent(agent.id) }); if (event.status === "done") onDone(agent.id); else if (event.status === "idle") publishBranch(agent.id); }
      broadcast({ type: "agent-event", agentId: agent.id, eventId, event });
    });
  }

  /** What the Plan screen shows: the feature, its spec text, its tickets with dependencies and looks, and the three gates. */
  function featureView(project: Project, f: Feature) {
    const all = readTickets(project.path, project.id);
    const mine = all.filter((t) => t.feature === f.slug);
    return {
      ...f,
      spec: features.specText(project.path, f),
      gates: features.gates(f, all),
      tickets: mine.map((t) => ({
        id: t.id, key: t.key, title: t.title, column: t.column, blocked: t.blocked, blockers: t.blockers, agent: t.agent,
        shape: f.looks[t.key]?.shape ?? null, color: f.looks[t.key]?.color ?? null,
      })),
    };
  }
  const featureChanged = (f: Feature) => {
    const project = store.projects().find((p) => p.id === f.projectId);
    if (project) broadcast({ type: "feature", feature: featureView(project, f) });
  };

  /** The user answered a spec or ticket gate in the Inbox: move the feature on, or send the lead back to revise. */
  function planDecided(item: { id: string; decision?: string | null }) {
    const f = store.features().find((x) => x.gateItemId === item.id);
    if (!f) return;
    const ok = item.decision === "approve";
    const stage = f.stage === "spec-gate" ? (ok ? "tickets" : "grill") : f.stage === "tickets-gate" ? (ok ? "build" : "tickets") : f.stage;
    featureChanged(features.update({ ...f, stage, gateItemId: null }));
    if (stage === "build") drain();
  }

  /** Offers a retro, once, for each feature whose tickets are all done. */
  function offerRetros() {
    if (closing) return;
    for (const f of store.features()) {
      if (f.retroItemId || f.stage !== "build") continue;
      const project = store.projects().find((p) => p.id === f.projectId);
      if (!project || features.gates(f, readTickets(project.path, project.id)).merge !== "approved") continue;
      const { item } = inbox.raise({
        kind: "retro", what: `Run a retro on: ${f.description}`, why: "Every ticket of this feature is done. A retro captures what to keep and what to change.",
        facts: [{ k: "Feature", v: f.description }], agentId: f.leadAgentId ?? "", projectId: project.id,
      });
      featureChanged(features.update({ ...f, retroItemId: item.id }));
    }
  }

  /** The user answered a retro offer: approving starts a retro agent. */
  function retroDecided(item: { id: string; decision?: string | null }) {
    const f = store.features().find((x) => x.retroItemId === item.id);
    const project = f && store.projects().find((p) => p.id === f.projectId);
    if (f && project && item.decision === "approve") spawn(project, "Retro", undefined, false, retroTask(f));
  }

  /** The planning tools of the lead agent of a feature; undefined for every other agent. */
  function leadTools(agentId: string) {
    const first = store.features().find((x) => x.leadAgentId === agentId);
    if (!first) return undefined;
    const fresh = () => features.get(first.id)!;
    const project = store.projects().find((p) => p.id === first.projectId)!;
    /** Raises the gate's Inbox item and waits for the verdict; planDecided moves the stage when the user answers. */
    const gate = async (stage: "spec-gate" | "tickets-gate", what: string, why: string, facts: { k: string; v: string }[]) => {
      const { item, answer } = inbox.raise({ kind: "plan", what, why, facts, agentId, projectId: project.id });
      featureChanged(features.update({ ...fresh(), stage, gateItemId: item.id }));
      return answer;
    };
    const specVerdict = (a: Answer) => {
      if (a.decision === "approve") return `Approved: the spec. Now slice it into tickets under .scratch/${fresh().slug}/issues and call submit_tickets.`;
      if (a.decision === "deny") return `Denied: the spec${a.reply ? `. Reason: ${a.reply}` : ""}. Revise it and call submit_spec again.`;
      return `The user replied: ${a.reply ?? ""}. Revise the spec and call submit_spec again.`;
    };
    const ticketsVerdict = (a: Answer) => {
      if (a.decision === "approve") return "Approved: the tickets. Bridge now starts workers for them; you are done.";
      if (a.decision === "deny") return `Denied: the tickets${a.reply ? `. Reason: ${a.reply}` : ""}. Revise them and call submit_tickets again.`;
      return `The user replied: ${a.reply ?? ""}. Revise the tickets and call submit_tickets again.`;
    };
    /** The gate's Inbox item is still open (a restart lost the first call): wait on it again. Otherwise just say it is waiting. */
    const waitingGate = async (f: Feature, verdict: (a: Answer) => string, fallback: string) => {
      const open = f.gateItemId ? store.inboxItem(f.gateItemId) : undefined;
      if (!open || open.status !== "open") return fallback;
      return verdict(await inbox.reattach(open.id));
    };
    const ticketsOf = (f: Feature) => readTickets(project.path, project.id).filter((t) => t.feature === f.slug);
    return {
      async submitSpec(summary: string) {
        const f = fresh();
        if (f.stage === "spec-gate") return waitingGate(f, specVerdict, "The spec is already waiting for the user's approval.");
        if (f.stage !== "grill") return "The spec is already approved. Slice it into tickets and call submit_tickets.";
        const text = features.specText(project.path, f);
        if (!text?.trim()) return `Write the spec to .scratch/${f.slug}/spec.md first, then call submit_spec.`;
        const a = await gate("spec-gate", `Approve the spec: ${f.description}`, summary, [{ k: "Feature", v: f.description }, { k: "Spec", v: `.scratch/${f.slug}/spec.md` }]);
        return specVerdict(a);
      },
      async submitTickets(input: { workers?: number; agents?: { ticket: string; shape: string; color: string }[] }) {
        const f = fresh();
        if (f.stage === "tickets-gate") return waitingGate(f, ticketsVerdict, "The tickets are already waiting for the user's approval.");
        if (f.stage === "build") return "The tickets are already approved and workers are building them.";
        if (f.stage !== "tickets") return "The spec must be approved before you submit tickets. Call submit_spec first.";
        const mine = ticketsOf(f);
        if (mine.length === 0) return `Write the tickets to .scratch/${f.slug}/issues first (NN-slug.md), then call submit_tickets.`;
        const looks: Feature["looks"] = {};
        for (const a of input.agents ?? []) {
          const t = mine.find((x) => Number(x.key) === Number(a.ticket));
          if (!t) return `No ticket ${a.ticket} in .scratch/${f.slug}/issues.`;
          const bad = checkLook(a.shape, a.color);
          if (bad) return `Ticket ${a.ticket}: ${bad}.`;
          looks[t.key] = { shape: a.shape as never, color: a.color };
        }
        featureChanged(features.update({ ...fresh(), looks, suggestedWorkers: input.workers ?? null }));
        const list = mine.map((t) => `${t.key} ${t.title}${t.blockers.length ? ` (after ${t.blockers.map((b) => b.key).join(", ")})` : ""}`).join("; ");
        const a = await gate("tickets-gate", `Approve ${mine.length} ticket${mine.length === 1 ? "" : "s"}: ${f.description}`,
          input.workers ? `The lead suggests ${input.workers} worker${input.workers === 1 ? "" : "s"}.` : "",
          [{ k: "Tickets", v: list }, ...(input.workers ? [{ k: "Suggested workers", v: String(input.workers) }] : [])]);
        return ticketsVerdict(a);
      },
    };
  }

  /**
   * The Analyst's data tools. Everything here runs on the host: the credential is read from its file only to hand
   * to the data source, and any error text is scrubbed of it before the agent sees it. Each dataset needs the user's
   * approval (once, or for the whole project) and results are masked unless that was switched off for the connection.
   */
  function analystTools(projectId: string, ask: AgentToolContext["requestAccess"]): NonNullable<AgentToolContext["analyst"]> {
    return {
      async listDatasets() {
        const on = connections.list(projectId).filter((c) => c.enabled);
        if (on.length === 0) return "No database connection is enabled for this project. Ask the user to enable one on the Analyst screen.";
        const out: unknown[] = [];
        for (const c of on) {
          const secret = connections.secret(c.id) ?? "";
          try { out.push({ connection: c.label, kind: c.kind, namesMasked: c.maskingOn, datasets: await dataSource.datasets(c.kind, secret) }); }
          catch (e) { out.push({ connection: c.label, error: `could not read this database: ${scrub((e as Error).message, secret)}` }); }
        }
        return JSON.stringify(out, null, 2);
      },
      async queryDataset({ connection, datasets, query }) {
        const c = connections.find(projectId, connection);
        if (!c) return `Refused: there is no connection named ${connection}. Call list_datasets.`;
        if (!c.enabled) return `Refused: connection ${c.label} is not enabled. Ask the user to enable it on the Analyst screen.`;
        const checked = checkReadOnly(c.kind, datasets, query, c.maskingOn);
        if (!checked.ok) return `Refused: ${checked.reason}.`;
        const secret = connections.secret(c.id);
        if (!secret) return `Refused: connection ${c.label} has no stored credential. Ask the user to add it again.`;
        for (const d of [...new Set(datasets)]) {
          const detail = `${c.label}/${d}`;
          const a = await ask("database", detail, {
            kind: "access", access: "database", detail, what: `Read ${detail} (read-only)`, why: "",
            facts: [
              { k: "Database", v: `${c.label} · read-only role` },
              { k: "Dataset", v: d },
              { k: "Names and identifiers", v: c.maskingOn ? "masked" : "NOT masked (turned off for this connection)" },
              { k: "Query", v: query },
            ],
          });
          if (a.decision === "deny") return `Denied: read ${detail}${a.reply ? `. Reason: ${a.reply}` : ""}. Nothing was run.`;
          if (a.decision === "reply") return `The user replied: ${a.reply ?? ""}. Nothing was run.`;
        }
        // The user may have switched it off, or changed masking, while the request was open.
        const now = connections.get(c.id);
        if (!now?.enabled) return `Refused: connection ${c.label} is not enabled any more.`;
        let rows;
        try { rows = await dataSource.query(c.kind, secret, { datasets, query: checked.query, limit: ROW_LIMIT + 1 }); }
        catch (e) {
          // With masking on, quoted values are cut out too: database errors echo the row data that caused them.
          const msg = scrub((e as Error).message, secret);
          return `Query failed: ${now.maskingOn ? withoutValues(msg) : msg}`;
        }
        const truncated = rows.length > ROW_LIMIT;
        const shown = truncated ? rows.slice(0, ROW_LIMIT) : rows;
        return JSON.stringify({ masked: now.maskingOn, truncated, rows: now.maskingOn ? maskRows(shown) : shown });
      },
    };
  }

  async function api(req: IncomingMessage, res: ServerResponse, path: string) {
    const method = req.method ?? "GET";
    if (path === "/api/health") return send(res, 200, { ok: true });
    if (path === "/api/pulls") return send(res, 200, store.pulls());
    if (path === "/api/reviews") return send(res, 200, store.reviews());
    const pullMerge = path.match(/^\/api\/pulls\/([^/]+)\/merge$/);
    if (pullMerge && method === "POST") {
      // Only the Bridge UI sends this header. A web page cannot add it to a cross-origin request without a
      // preflight the daemon never allows. It does not stop a local process that sets the header itself.
      if (req.headers["x-bridge-ui"] !== "1") return send(res, 403, { error: "merging is done from the Bridge Review screen" });
      const r = await pulls.merge(pullMerge[1]!);
      if (r.code === 200) drain();
      return send(res, r.code, r.body);
    }
    if (path === "/api/quit-check") return send(res, 200, { running: liveAgents().map((a) => ({ ...brief(a), status: a.status })), warning: quitWarning() });
    if (path === "/api/restart") return send(res, 200, restartReport);
    if (path === "/api/quit" && method === "POST") {
      if (req.headers["x-bridge-ui"] !== "1") return send(res, 403, { error: "quitting is done from the Bridge UI" });
      const { confirmed } = await readJson(req);
      const warning = quitWarning();
      if (warning && confirmed !== true) return send(res, 409, { error: "agents are still running", warning, running: liveAgents().map(brief) });
      send(res, 200, { ok: true, stopping: liveAgents().length });
      setTimeout(() => opts.onQuit?.(), 50);
      return;
    }
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
      for (const q of queue) delete q.error;
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
    if (path === "/api/projects/new" && method === "POST") {
      const { name, parent, github, approved } = await readJson(req);
      if (!validProjectName(name)) return send(res, 400, { error: "name must be a plain folder name" });
      if (typeof parent !== "string" || !parent || !existsSync(resolve(parent)) || !statSync(resolve(parent)).isDirectory()) return send(res, 400, { error: "parent folder not found" });
      const dir = join(resolve(parent), name);
      if (!isFreeTarget(dir)) return send(res, 409, { error: "that folder already exists and is not empty" });
      const steps = newProjectSteps(dir, github === true);
      if (approved !== true) return send(res, 200, { approved: false, path: dir, steps });
      try { scaffoldProject(dir, name); } catch (e) { return send(res, 500, { error: `could not create the repo: ${(e as Error).message}` }); }
      const project = { id: randomUUID(), name, path: dir, workspaceId: DEFAULT_WORKSPACE };
      store.addProject(project);
      store.setSetting(`setupDone:${project.id}`, "1");
      broadcast({ type: "project", project });
      watchProject(project);
      store.setActiveProject(project.id);
      broadcast({ type: "active-project", projectId: project.id });
      let gh: unknown;
      if (github === true) gh = opts.github ? await opts.github.createRepository({ repoPath: dir, name, private: true }) : { ok: false, reason: "GitHub is not available" };
      return send(res, 201, { project, ...(gh ? { github: gh } : {}) });
    }
    const sm = path.match(/^\/api\/projects\/([^/]+)\/setup$/);
    if (sm) {
      const project = store.projects().find((p) => p.id === sm[1]);
      if (!project) return send(res, 404, { error: "unknown project" });
      const view = () => ({ needed: store.setting(`setupDone:${project.id}`) !== "1" && !isConfigured(project.path) });
      if (method === "GET") return send(res, 200, view());
      if (method === "POST") {
        const { tracker, labels } = await readJson(req);
        if (!(TRACKERS as readonly string[]).includes(tracker)) return send(res, 400, { error: "tracker must be local or github" });
        const written = runSetup(project.path, tracker as Tracker, labels && typeof labels === "object" ? labels : {});
        store.setSetting(`setupDone:${project.id}`, "1");
        return send(res, 200, { ...view(), written });
      }
    }
    const adm = path.match(/^\/api\/projects\/([^/]+)\/auto-dispatch$/);
    if (adm) {
      const project = store.projects().find((p) => p.id === adm[1]);
      if (!project) return send(res, 404, { error: "unknown project" });
      if (method === "GET") return send(res, 200, { on: autoDispatchOn(project.id) });
      if (method === "POST") {
        const { on } = await readJson(req);
        if (typeof on !== "boolean") return send(res, 400, { error: "on must be true or false" });
        store.setSetting(`autoDispatch:${project.id}`, on ? "1" : "0");
        drain();
        return send(res, 200, { on });
      }
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
      const hold = ticket && !lead ? held(project.id, ticket) : undefined;
      if (ticket && hold) return send(res, 409, { error: `Not started: ${features.holdReason(hold)}. Approve it in the Inbox first.` });
      if (ticket && !lead && (rateLimit || running() >= cap() || ticket.blocked)) {
        const entry = toQueued(project, ticket, name);
        queue.push(entry);
        limitsChanged();
        return send(res, 202, { queued: true, id: entry.id, position: queue.length });
      }
      const r = spawn(project, name, ticket, lead);
      return send(res, r.code, r.body);
    }
    const fm = path.match(/^\/api\/projects\/([^/]+)\/features$/);
    if (fm) {
      const project = store.projects().find((p) => p.id === fm[1]);
      if (!project) return send(res, 404, { error: "unknown project" });
      if (method === "GET") return send(res, 200, features.list(project.id).map((f) => featureView(project, f)));
      if (method === "POST") {
        const { description } = await readJson(req);
        if (typeof description !== "string" || !description.trim()) return send(res, 400, { error: "describe the feature" });
        const f = features.create({ id: randomUUID(), projectId: project.id, description: description.trim(), leadAgentId: null });
        const r = spawn(project, "Lead", undefined, true, leadTask(f));
        if (r.code !== 201) return send(res, r.code, r.body);
        const withLead = features.update({ ...f, leadAgentId: (r.body as { id: string }).id });
        broadcast({ type: "feature", feature: featureView(project, withLead) });
        return send(res, 201, featureView(project, withLead));
      }
    }
    const fg = path.match(/^\/api\/features\/([^/]+)$/);
    if (fg && method === "GET") {
      const f = features.get(fg[1]);
      const project = f && store.projects().find((p) => p.id === f.projectId);
      return f && project ? send(res, 200, featureView(project, f)) : send(res, 404, { error: "unknown feature" });
    }
    if (path === "/api/quick-actions" && method === "GET") return send(res, 200, QUICK_ACTIONS);
    const qm = path.match(/^\/api\/projects\/([^/]+)\/quick-actions$/);
    if (qm && method === "POST") {
      const project = store.projects().find((p) => p.id === qm[1]);
      if (!project) return send(res, 404, { error: "unknown project" });
      const { action, context } = await readJson(req);
      const a = QUICK_ACTIONS.find((x) => x.id === action);
      if (!a) return send(res, 400, { error: "unknown action" });
      const r = spawn(project, a.label, undefined, false, quickActionTask(a, typeof context === "string" ? context : ""));
      return send(res, r.code, r.body);
    }
    const cm = path.match(/^\/api\/projects\/([^/]+)\/connections$/);
    if (cm) {
      const project = store.projects().find((p) => p.id === cm[1]);
      if (!project) return send(res, 404, { error: "unknown project" });
      if (method === "GET") return send(res, 200, { connections: connections.list(project.id), analystReady: analystReady(project.id) });
      if (method === "POST") {
        const { kind, label, connectionString } = await readJson(req);
        if (!(CONNECTION_KINDS as readonly string[]).includes(kind)) return send(res, 400, { error: "kind must be postgres or mongodb" });
        if (typeof label !== "string" || !label.trim() || label.trim().length > 40) return send(res, 400, { error: "give the connection a short name" });
        const urlStart = kind === "postgres" ? /^postgres(ql)?:\/\//i : /^mongodb(\+srv)?:\/\//i;
        if (typeof connectionString !== "string" || !urlStart.test(connectionString.trim())) return send(res, 400, { error: `the connection string must start with ${kind === "postgres" ? "postgres://" : "mongodb:// or mongodb+srv://"}` });
        if (connections.find(project.id, label.trim())) return send(res, 409, { error: "a connection with that name already exists" });
        const secret = connectionString.trim();
        try { await dataSource.datasets(kind as ConnectionKind, secret); }
        catch (e) { return send(res, 400, { error: `could not connect: ${scrub((e as Error).message, secret)}` }); }
        // The pasted role must really be read-only, whatever the wizard said.
        let writable: string | null = null;
        try { writable = await dataSource.writeAccess(kind as ConnectionKind, secret); }
        catch (e) { writable = `could not check what the role may do (${scrub((e as Error).message, secret)})`; }
        if (writable) return send(res, 400, { error: `That role is not read-only: ${writable}. Run the setup steps again and paste the new connection string.` });
        // Off until the user turns it on, with masking on.
        const c = { id: randomUUID(), projectId: project.id, kind: kind as ConnectionKind, label: label.trim(), enabled: false, maskingOn: true, createdAt: Date.now() };
        connections.add(c, secret);
        broadcast({ type: "connections", projectId: project.id });
        return send(res, 201, c);
      }
    }
    const rs = path.match(/^\/api\/projects\/([^/]+)\/connections\/role-setup$/);
    if (rs && method === "POST") {
      if (!store.projects().some((p) => p.id === rs[1])) return send(res, 404, { error: "unknown project" });
      const { kind, database, role, tables } = await readJson(req);
      if (!(CONNECTION_KINDS as readonly string[]).includes(kind)) return send(res, 400, { error: "kind must be postgres or mongodb" });
      if (!validIdentifier(database) || !validIdentifier(role)) return send(res, 400, { error: "database and role must be plain names: letters, digits and underscores" });
      if (tables !== undefined && (!Array.isArray(tables) || !tables.every(validIdentifier))) return send(res, 400, { error: "tables must be plain table names" });
      // A preview only. The user runs these steps themselves; Bridge never holds admin credentials.
      return send(res, 200, { steps: roleSetupSteps({ kind, database, role, tables }) });
    }
    const cx = path.match(/^\/api\/connections\/([^/]+)$/);
    if (cx) {
      const c = connections.get(cx[1]!);
      if (!c) return send(res, 404, { error: "unknown connection" });
      if (method === "DELETE") {
        connections.remove(c.id);
        broadcast({ type: "connections", projectId: c.projectId });
        return send(res, 200, { ok: true });
      }
      if (method === "POST") {
        const { enabled, maskingOn } = await readJson(req);
        if ((enabled !== undefined && typeof enabled !== "boolean") || (maskingOn !== undefined && typeof maskingOn !== "boolean")) return send(res, 400, { error: "enabled and maskingOn must be true or false" });
        const next = { ...c, enabled: enabled ?? c.enabled, maskingOn: maskingOn ?? c.maskingOn };
        connections.update(next);
        broadcast({ type: "connections", projectId: c.projectId });
        return send(res, 200, next);
      }
    }
    const an = path.match(/^\/api\/projects\/([^/]+)\/analyst$/);
    if (an) {
      const project = store.projects().find((p) => p.id === an[1]);
      if (!project) return send(res, 404, { error: "unknown project" });
      const live = store.agents().find((a) => a.projectId === project.id && a.analyst && a.status !== "done");
      if (method === "GET") return send(res, 200, { ready: analystReady(project.id), running: live?.id ?? null });
      if (method === "POST") {
        if (!analystReady(project.id)) return send(res, 409, { error: "The Analyst is off. Enable a database connection on the Analyst screen first." });
        if (live) return send(res, 409, { error: "An Analyst is already running for this project" });
        const { question } = await readJson(req);
        const ask = typeof question === "string" ? question : "";
        const r = spawn(project, "Analyst", undefined, false, analystTask(ask), true);
        if (r.code === 201) store.setSetting(`analystAsk:${(r.body as { id: string }).id}`, ask);
        return send(res, r.code, mode === "local" && r.code === 201
          ? { ...(r.body as object), warning: "Local mode has no sandbox, so this Analyst shares your computer. Prefer running Bridge with Docker Sandboxes for real data." }
          : r.body);
      }
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
      if (item?.kind === "plan") planDecided(item);
      if (item?.kind === "retro") retroDecided(item);
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
      const stopError = stopRunner(a.id);
      publishBranch(a.id);
      pulls.forget(a.id);
      agentBranch.delete(a.id); announced.delete(a.id); agentCwd.delete(a.id); agentBase.delete(a.id);
      store.deleteSetting(`agentRun:${a.id}`);
      store.deleteSetting(`analystAsk:${a.id}`);
      hookTokens.delete(a.id);
      store.deleteAgent(a.id);
      try { workspaces.remove(a.id); } catch { /* clone already gone */ }
      broadcast({ type: "agent-deleted", agentId: a.id });
      drain();
      return send(res, 200, stopError ? { ok: true, warning: `Could not end the agent's process: ${stopError}. A leftover process may still be running.` } : { ok: true });
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
        const stopError = stopRunner(a.id);
        if (stopError) {
          const event: AgentEvent = { type: "output", data: `\r\n[Bridge] Could not end this agent's process: ${stopError}\r\n` };
          broadcast({ type: "agent-event", agentId: a.id, eventId: store.addEvent(a.id, event), event });
        }
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
      const raise: AgentToolContext["raise"] = async (item) => {
        const { answer } = inbox.raise({ ...item, agentId: id, projectId: agent.projectId, ticketKey: agent.ticketKey });
        setStatus("blocked");
        const a = await answer;
        if (store.agent(id)?.status === "blocked") setStatus("working");
        return a;
      };
      const requestAccess: AgentToolContext["requestAccess"] = async (kind, detail, item) => {
        if (approvals.covering(agent.projectId, agent.ticketKey ?? null, kind, detail)) return { decision: "approve" };
        return raise(item);
      };
      handleAgentTools({
        analyst: agent.analyst ? analystTools(agent.projectId, requestAccess) : undefined,
        ticket: () => {
          const t = project && agent.ticketId ? readTickets(project.path, project.id).find((x) => x.id === agent.ticketId) : undefined;
          if (!t || !project) return null;
          let body = "";
          try { body = readFileSync(join(project.path, t.file), "utf8"); } catch { /* file gone */ }
          return { key: t.key, title: t.title, status: t.status, blockers: t.blockers, file: t.file, body };
        },
        lead: leadTools(id),
        setStatus: (s) => { if (store.agent(id)?.status !== "done") { setStatus(s); if (s === "done") onDone(id); } },
        requestAccess,
        raise,
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

  // Resume what the last launch left unfinished.
  const previousExit = (() => { try { return JSON.parse(store.setting("lastExit") ?? "null") as (ExitReport & { at: number }) | null; } catch { return null; } })();
  store.deleteSetting("lastExit");
  const say = (agentId: string, text: string) => {
    const event: AgentEvent = { type: "output", data: `\r\n[Bridge] ${text}\r\n` };
    broadcast({ type: "agent-event", agentId, eventId: store.addEvent(agentId, event), event });
  };
  const RESUME_NOTE = "Bridge was restarted and interrupted you. Continue where you left off: check git status and git log in this folder, and the acceptance boxes in your ticket, before doing anything.";
  const finishInterrupted = (a: AgentRow, why: string) => {
    store.setStatus(a.id, "done");
    say(a.id, `Not resumed: ${why}.`);
    broadcast({ type: "agent", agent: store.agent(a.id) });
  };
  const resumed: ReturnType<typeof brief>[] = [];
  for (const a of liveAgents()) {
    const project = store.projects().find((p) => p.id === a.projectId);
    if (!project) { finishInterrupted(a, "its project is no longer registered"); continue; }
    let cwd = project.path;
    let task: string | undefined;
    let env: Record<string, string> | undefined;
    let isolated = false;
    if (a.analyst) {
      if (!analystReady(a.projectId)) { finishInterrupted(a, "no database connection is enabled any more"); continue; }
      cwd = analystDir(a.id);
      task = `${analystTask(store.setting(`analystAsk:${a.id}`) ?? "")} Bridge was restarted and interrupted you. Continue your analysis; call list_datasets again first.`;
    } else if (a.lead) {
      const f = store.features().find((x) => x.leadAgentId === a.id);
      if (!f || f.stage === "build") { finishInterrupted(a, "its planning is finished"); continue; }
      // A gate's Inbox item survives the restart; calling submit_spec or submit_tickets again waits on that same item.
      task = `${leadTask(f)} ${RESUME_NOTE} If you had already called submit_spec or submit_tickets, call it again: it waits for the same pending approval.`;
    } else if (a.ticketId) {
      const ticket = readTickets(project.path, project.id).find((t) => t.id === a.ticketId);
      if (!ticket) { finishInterrupted(a, "its ticket file is gone"); continue; }
      let saved: { cwd: string; branch: string; base?: string } | null = null;
      try { saved = JSON.parse(store.setting(`agentRun:${a.id}`) ?? "null"); } catch { /* fall through to a fresh clone */ }
      if (!saved || !existsSync(saved.cwd)) {
        try {
          const ws = workspaces.prepare({ agentId: a.id, projectPath: project.path, ticketFile: ticket.file, ticketKey: ticket.key });
          saved = ws ? { cwd: ws.path, branch: ws.branch, base: ws.base } : null;
          if (ws) store.setSetting(`agentRun:${a.id}`, JSON.stringify(saved));
        } catch (e) { finishInterrupted(a, `its clone could not be recreated (${(e as Error).message})`); continue; }
      }
      if (saved) {
        cwd = saved.cwd; isolated = true;
        agentBranch.set(a.id, saved.branch); agentCwd.set(a.id, saved.cwd);
        if (saved.base) agentBase.set(a.id, saved.base);
        env = workspaces.readEnv(saved.cwd);
      }
      task = `${taskFor(ticket)} ${RESUME_NOTE}`;
    }
    // Questions asked before the restart can no longer be answered to the old process; the agent asks again.
    for (const item of inbox.list().filter((i) => i.agentId === a.id && i.status === "open" && i.kind !== "plan")) {
      inbox.resolve(item.id, { decision: "deny", reply: "Bridge restarted before this was answered. Ask again if you still need it." });
    }
    store.setStatus(a.id, "working");
    broadcast({ type: "agent", agent: store.agent(a.id) });
    say(a.id, "Resumed after Bridge restarted.");
    const failedStop = previousExit?.failed.find((f) => f.id === a.id);
    if (failedStop) say(a.id, `This agent could not be stopped when Bridge last closed (${failedStop.error}). A leftover process may still be running; check Task Manager.`);
    launch(store.agent(a.id)!, cwd, task, env, isolated);
    resumed.push(brief(a));
  }
  const restartReport = {
    resumed,
    previousExit: previousExit ? { at: previousExit.at, stopped: previousExit.stopped, failed: previousExit.failed } : null,
    notice: previousExit?.failed.length
      ? `${previousExit.failed.length} agent${previousExit.failed.length === 1 ? "" : "s"} could not be stopped when Bridge last closed: ${previousExit.failed.map((f) => `${f.name}${f.ticketKey ? ` (ticket ${f.ticketKey})` : ""}: ${f.error}`).join("; ")}. Leftover processes may still be running.`
      : null,
  };
  // Features that finished before retros existed are not offered one: mark them handled, once.
  if (!store.setting("retroBackfillDone")) {
    for (const f of store.features()) {
      const project = store.projects().find((p) => p.id === f.projectId);
      if (!f.retroItemId && f.stage === "build" && project && features.gates(f, readTickets(project.path, project.id)).merge === "approved") {
        features.update({ ...f, retroItemId: "skipped" });
      }
    }
    store.setSetting("retroBackfillDone", "1");
  }
  for (const p of store.projects()) watchProject(p);
  drain();

  return {
    port,
    url: `http://127.0.0.1:${port}`,
    /** What the last close() did to running agents; null before it is called. */
    exit: null as ExitReport | null,
    async close(): Promise<void> {
      // Agents die with the daemon. Stop each one, record the outcome, and keep them unfinished so they resume next launch.
      if (closing) return;
      closing = true;
      const report: ExitReport = { stopped: [], failed: [] };
      for (const a of liveAgents()) {
        const error = stopRunner(a.id);
        if (error) report.failed.push({ ...brief(a), error }); else report.stopped.push(brief(a));
      }
      store.setSetting("lastExit", JSON.stringify({ at: Date.now(), ...report }));
      this.exit = report;
      clearInterval(pollTimer);
      for (const stop of watchers.values()) stop();
      for (const s of sockets) s.terminate();
      server.closeAllConnections();
      wss.close();
      await new Promise<void>((r) => server.close(() => r()));
      store.close();
    },
  };
}
