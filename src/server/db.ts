import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { AgentEvent, AgentStatus } from "./agent-runner.ts";

export interface Project { id: string; name: string; path: string; workspaceId: string }
export interface Workspace { id: string; name: string; repos: Project[] }
export const DEFAULT_WORKSPACE = "default";
export interface AgentRow { id: string; projectId: string; name: string; status: AgentStatus; ticketId?: string | null; ticketKey?: string | null; ticketTitle?: string | null }
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
  `);
  // Migrate databases created before workspaces existed.
  if (!(db.prepare("PRAGMA table_info(projects)").all() as { name: string }[]).some((c) => c.name === "workspace_id")) {
    db.exec(`ALTER TABLE projects ADD COLUMN workspace_id TEXT NOT NULL DEFAULT '${DEFAULT_WORKSPACE}'`);
  }
  const agentCols = (db.prepare("PRAGMA table_info(agents)").all() as { name: string }[]).map((c) => c.name);
  for (const c of ["ticket_id", "ticket_key", "ticket_title"]) if (!agentCols.includes(c)) db.exec(`ALTER TABLE agents ADD COLUMN ${c} TEXT`);
  db.prepare("INSERT OR IGNORE INTO workspaces (id, name) VALUES (?, ?)").run(DEFAULT_WORKSPACE, "Default");
  const listProjects = () =>
    db.prepare("SELECT id, name, path, workspace_id AS workspaceId FROM projects ORDER BY rowid").all() as unknown as Project[];
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
      db.prepare("INSERT INTO agents (id, project_id, name, status, ticket_id, ticket_key, ticket_title) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(a.id, a.projectId, a.name, a.status, a.ticketId ?? null, a.ticketKey ?? null, a.ticketTitle ?? null);
    },
    setStatus(id: string, status: AgentStatus) {
      db.prepare("UPDATE agents SET status = ? WHERE id = ?").run(status, id);
    },
    agents(): AgentRow[] {
      return db.prepare("SELECT id, project_id AS projectId, name, status, ticket_id AS ticketId, ticket_key AS ticketKey, ticket_title AS ticketTitle FROM agents ORDER BY rowid").all() as unknown as AgentRow[];
    },
    addEvent(agentId: string, event: AgentEvent) {
      db.prepare("INSERT INTO events (agent_id, json) VALUES (?, ?)").run(agentId, JSON.stringify(event));
    },
    events(agentId: string): StoredEvent[] {
      const rows = db.prepare("SELECT id, agent_id, json FROM events WHERE agent_id = ? ORDER BY id").all(agentId) as unknown as { id: number; agent_id: string; json: string }[];
      return rows.map((r) => ({ id: r.id, agentId: r.agent_id, event: JSON.parse(r.json) as AgentEvent }));
    },
    close() { db.close(); },
  };
}
