import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { AgentEvent, AgentStatus } from "./agent-runner.ts";

export interface Project { id: string; name: string; path: string }
export interface AgentRow { id: string; projectId: string; name: string; status: AgentStatus }
export interface StoredEvent { id: number; agentId: string; event: AgentEvent }

export function openStore(dataDir: string) {
  mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(join(dataDir, "bridge.db"));
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS agents (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, name TEXT NOT NULL, status TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT NOT NULL, json TEXT NOT NULL);
  `);
  return {
    addProject(p: Project) {
      db.prepare("INSERT INTO projects (id, name, path) VALUES (?, ?, ?)").run(p.id, p.name, p.path);
    },
    projects(): Project[] {
      return db.prepare("SELECT id, name, path FROM projects ORDER BY rowid").all() as unknown as Project[];
    },
    addAgent(a: AgentRow) {
      db.prepare("INSERT INTO agents (id, project_id, name, status) VALUES (?, ?, ?, ?)").run(a.id, a.projectId, a.name, a.status);
    },
    setStatus(id: string, status: AgentStatus) {
      db.prepare("UPDATE agents SET status = ? WHERE id = ?").run(status, id);
    },
    agents(): AgentRow[] {
      return db.prepare("SELECT id, project_id AS projectId, name, status FROM agents ORDER BY rowid").all() as unknown as AgentRow[];
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
