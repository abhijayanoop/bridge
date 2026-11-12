import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ConnectionKind } from "./datasource.ts";

/** A database the Analyst may read for one project. Holds no credential: that lives in its own file on the host. */
export interface Connection {
  id: string; projectId: string; kind: ConnectionKind; label: string;
  /** Off until the user turns it on; the Analyst cannot start or query without an enabled connection. */
  enabled: boolean;
  /** On by default. Names and identifiers in results are replaced with pseudonyms. */
  maskingOn: boolean;
  createdAt: number;
}

export interface ConnectionStore {
  addConnection(c: Connection): void;
  connections(): Connection[];
  updateConnection(c: Connection): void;
  deleteConnection(id: string): void;
}

/**
 * Connections and their credentials. A credential is written to `<dataDir>/secrets/<id>` (owner-only where the OS
 * supports it) and read only by the daemon when it queries. It is never put in the database, an API response, an
 * agent's environment or its tool config.
 */
export function createConnections(store: ConnectionStore, dataDir: string) {
  const dir = join(dataDir, "secrets");
  const file = (id: string) => join(dir, id);
  return {
    list(projectId?: string): Connection[] { return store.connections().filter((c) => !projectId || c.projectId === projectId); },
    get(id: string): Connection | undefined { return store.connections().find((c) => c.id === id); },
    find(projectId: string, label: string): Connection | undefined {
      return store.connections().find((c) => c.projectId === projectId && c.label.toLowerCase() === label.toLowerCase());
    },
    add(c: Connection, secret: string) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(file(c.id), secret, { mode: 0o600 });
      try { chmodSync(file(c.id), 0o600); } catch { /* not supported on this OS */ }
      store.addConnection(c);
    },
    update(c: Connection) { store.updateConnection(c); },
    secret(id: string): string | null {
      return this.get(id) && existsSync(file(id)) ? readFileSync(file(id), "utf8") : null;
    },
    remove(id: string) {
      store.deleteConnection(id);
      rmSync(file(id), { force: true });
    },
  };
}
