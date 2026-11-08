import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { AgentEvent, AgentStatus } from "./agent-runner.ts";
import { avatarState, type AvatarState } from "../shared/avatar.ts";

export interface Project { id: string; name: string; path: string; workspaceId: string }
export interface Workspace { id: string; name: string; repos: Project[] }
export const DEFAULT_WORKSPACE = "default";
export interface AgentRow { id: string; projectId: string; name: string; status: AgentStatus; ticketId?: string | null; ticketKey?: string | null; ticketTitle?: string | null; shape?: string; color?: string; lead?: boolean; activity?: string | null; avatarState?: AvatarState }
export type InboxKind = "question" | "access" | "plan" | "merge";
export interface InboxItem {
  id: string; agentId: string; projectId: string; kind: InboxKind;
  /** For access requests: domain, secret, push or database. */
  access?: string | null;
  /** For access requests: the domain, secret name, branch or database asked for. */
  detail?: string | null;
  what: string; why: string; facts: { k: string; v: string }[];
  ticketKey?: string | null; createdAt: number;
  status: "open" | "resolved"; decision?: "approve" | "deny" | "reply" | null; reply?: string | null; resolvedAt?: number | null;
}
export type ApprovalScope = "once" | "ticket" | "project";
/** A decision to allow something. Ticket and project grants are reused; all are listed so they can be undone. */
export interface Approval {
  id: string; projectId: string; ticketKey: string | null; access: string; detail: string; scope: ApprovalScope;
  createdAt: number; revokedAt: number | null;
  /** True when Bridge added the network rule for this domain, so only Bridge removes it. */
  ownsRule: boolean;
}
export interface StoredEvent { id: number; agentId: string; event: AgentEvent }

export function openStore(dataDir: string) {
  mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(join(dataDir, "bridge.db"));
  db.exec(`
    CREATE TABLE IF NOT EXISTS workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL);
    -- Tickets live in each repo's .scratch files; the early tickets table was a second source of truth.
    DROP TABLE IF EXISTS tickets;
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS agents (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, name TEXT NOT NULL, status TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT NOT NULL, json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS inbox (id TEXT PRIMARY KEY, json TEXT NOT NULL, seq INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS approvals (id TEXT PRIMARY KEY, json TEXT NOT NULL, seq INTEGER NOT NULL);
  `);
  // Migrate databases created before workspaces existed.
  if (!(db.prepare("PRAGMA table_info(projects)").all() as { name: string }[]).some((c) => c.name === "workspace_id")) {
    db.exec(`ALTER TABLE projects ADD COLUMN workspace_id TEXT NOT NULL DEFAULT '${DEFAULT_WORKSPACE}'`);
  }
  const agentCols = (db.prepare("PRAGMA table_info(agents)").all() as { name: string }[]).map((c) => c.name);
  for (const c of ["ticket_id", "ticket_key", "ticket_title", "shape", "color", "lead", "activity"]) if (!agentCols.includes(c)) db.exec(`ALTER TABLE agents ADD COLUMN ${c} TEXT`);
  db.prepare("INSERT OR IGNORE INTO workspaces (id, name) VALUES (?, ?)").run(DEFAULT_WORKSPACE, "Default");
  const listProjects = () =>
    db.prepare("SELECT id, name, path, workspace_id AS workspaceId FROM projects ORDER BY rowid").all() as unknown as Project[];
  const listAgents = (): AgentRow[] => {
    const rows = db.prepare("SELECT id, project_id AS projectId, name, status, ticket_id AS ticketId, ticket_key AS ticketKey, ticket_title AS ticketTitle, shape, color, lead, activity FROM agents ORDER BY rowid").all() as unknown as (Omit<AgentRow, "lead"> & { lead: number | string | null })[];
    return rows.map((r) => ({ ...r, lead: Number(r.lead) === 1, avatarState: avatarState(r.status, r.activity) }));
  };
  return {
    addProject(p: Omit<Project, "workspaceId"> & { workspaceId?: string }) {
      db.prepare("INSERT INTO projects (id, name, path, workspace_id) VALUES (?, ?, ?, ?)")
        .run(p.id, p.name, p.path, p.workspaceId ?? DEFAULT_WORKSPACE);
    },
    projects: listProjects,
    workspaces(): Workspace[] {
      const repos = listProjects();
      const rows = db.prepare("SELECT id, name FROM workspaces ORDER BY rowid").all() as unknown as { id: string; name: string }[];
      return rows.map((w) => ({ ...w, repos: repos.filter((r) => r.workspaceId === w.id) }));
    },
    activeProjectId(): string | null {
      const row = db.prepare("SELECT value FROM settings WHERE key = 'activeProjectId'").get() as { value: string } | undefined;
      return row?.value ?? null;
    },
    setActiveProject(id: string) {
      db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('activeProjectId', ?)").run(id);
    },
    addAgent(a: AgentRow) {
      db.prepare("INSERT INTO agents (id, project_id, name, status, ticket_id, ticket_key, ticket_title, shape, color, lead, activity) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(a.id, a.projectId, a.name, a.status, a.ticketId ?? null, a.ticketKey ?? null, a.ticketTitle ?? null, a.shape ?? null, a.color ?? null, a.lead ? 1 : 0, a.activity ?? null);
    },
    /** Sets the status; activity is kept only while working. */
    setStatus(id: string, status: AgentStatus, activity?: string | null) {
      db.prepare("UPDATE agents SET status = ?, activity = ? WHERE id = ?").run(status, status === "working" ? activity ?? null : null, id);
    },
    agent(id: string): AgentRow | undefined {
      return listAgents().find((a) => a.id === id);
    },
    agents: listAgents,
    deleteAgent(id: string): boolean {
      db.prepare("DELETE FROM events WHERE agent_id = ?").run(id);
      return Number(db.prepare("DELETE FROM agents WHERE id = ?").run(id).changes) > 0;
    },
    addEvent(agentId: string, event: AgentEvent) {
      db.prepare("INSERT INTO events (agent_id, json) VALUES (?, ?)").run(agentId, JSON.stringify(event));
    },
    events(agentId: string): StoredEvent[] {
      const rows = db.prepare("SELECT id, agent_id, json FROM events WHERE agent_id = ? ORDER BY id").all(agentId) as unknown as { id: number; agent_id: string; json: string }[];
      return rows.map((r) => ({ id: r.id, agentId: r.agent_id, event: JSON.parse(r.json) as AgentEvent }));
    },
    addInbox(item: InboxItem) {
      db.prepare("INSERT INTO inbox (id, json, seq) VALUES (?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM inbox))").run(item.id, JSON.stringify(item));
    },
    inboxItem(id: string): InboxItem | undefined {
      const row = db.prepare("SELECT json FROM inbox WHERE id = ?").get(id) as { json: string } | undefined;
      return row ? (JSON.parse(row.json) as InboxItem) : undefined;
    },
    /** Newest first. */
    inboxItems(): InboxItem[] {
      const rows = db.prepare("SELECT json FROM inbox ORDER BY seq DESC").all() as unknown as { json: string }[];
      return rows.map((r) => JSON.parse(r.json) as InboxItem);
    },
    updateInbox(item: InboxItem) {
      db.prepare("UPDATE inbox SET json = ? WHERE id = ?").run(JSON.stringify(item), item.id);
    },
    addApproval(a: Approval) {
      db.prepare("INSERT INTO approvals (id, json, seq) VALUES (?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM approvals))").run(a.id, JSON.stringify(a));
    },
    approval(id: string): Approval | undefined {
      const row = db.prepare("SELECT json FROM approvals WHERE id = ?").get(id) as { json: string } | undefined;
      return row ? (JSON.parse(row.json) as Approval) : undefined;
    },
    /** Oldest first. */
    approvals(): Approval[] {
      const rows = db.prepare("SELECT json FROM approvals ORDER BY seq").all() as unknown as { json: string }[];
      return rows.map((r) => JSON.parse(r.json) as Approval);
    },
    updateApproval(a: Approval) {
      db.prepare("UPDATE approvals SET json = ? WHERE id = ?").run(JSON.stringify(a), a.id);
    },
    close() { db.close(); },
  };
}
