import type { ConnectionKind, DataSource, Dataset } from "./datasource.ts";
import type { Row } from "./masking.ts";

/** Milliseconds a query may run before the database cancels it. */
const QUERY_MS = 15_000;
const CONNECT_MS = 8_000;

/**
 * The real data source: `pg` for Postgres and Supabase, `mongodb` for MongoDB. Read-only twice over: the user's
 * role has no write rights (the setup wizard creates it), and every session also asks the server for a read-only
 * transaction. The drivers load on first use so Bridge starts fast without a database.
 *
 * Not run by `npm test` (no network in the default suite); see docs/manual-check-analyst.md.
 */
export function createRealDataSource(): DataSource {
  async function withPg<T>(secret: string, fn: (c: import("pg").Client) => Promise<T>): Promise<T> {
    const { default: pg } = await import("pg");
    const client = new pg.Client({
      connectionString: secret, connectionTimeoutMillis: CONNECT_MS, statement_timeout: QUERY_MS, query_timeout: QUERY_MS + 2000,
      options: "-c default_transaction_read_only=on",
    });
    await client.connect();
    try { return await fn(client); } finally { await client.end().catch(() => {}); }
  }

  async function withMongo<T>(secret: string, fn: (db: import("mongodb").Db) => Promise<T>): Promise<T> {
    const { MongoClient } = await import("mongodb");
    const client = new MongoClient(secret, { serverSelectionTimeoutMS: CONNECT_MS, readPreference: "secondaryPreferred", appName: "bridge-analyst" });
    await client.connect();
    try { return await fn(client.db()); } finally { await client.close().catch(() => {}); }
  }

  return {
    async datasets(kind: ConnectionKind, secret: string): Promise<Dataset[]> {
      if (kind === "postgres") {
        return withPg(secret, async (c) => {
          const r = await c.query<{ table_name: string; column_name: string }>(
            "SELECT table_name, column_name FROM information_schema.columns WHERE table_schema NOT IN ('pg_catalog', 'information_schema') ORDER BY table_name, ordinal_position");
          const by = new Map<string, string[]>();
          for (const row of r.rows) by.set(row.table_name, [...(by.get(row.table_name) ?? []), row.column_name]);
          return [...by].map(([name, columns]) => ({ name, columns }));
        });
      }
      return withMongo(secret, async (db) => {
        const out: Dataset[] = [];
        for (const c of await db.listCollections({}, { nameOnly: true }).toArray()) {
          const sample = await db.collection(c.name).findOne({}, { maxTimeMS: QUERY_MS });
          out.push({ name: c.name, columns: sample ? Object.keys(sample) : [] });
        }
        return out;
      });
    },

    async writeAccess(kind: ConnectionKind, secret: string): Promise<string | null> {
      if (kind === "postgres") {
        return withPg(secret, async (c) => {
          const r = await c.query<{ powerful: boolean; can_create: boolean; writes: string | null }>(
            `SELECT (SELECT rolsuper OR rolcreatedb OR rolcreaterole FROM pg_roles WHERE rolname = current_user) AS powerful,
                    has_schema_privilege(current_user, 'public', 'CREATE') AS can_create,
                    (SELECT string_agg(DISTINCT privilege_type || ' on ' || table_name, ', ') FROM information_schema.role_table_grants
                      WHERE grantee IN (current_user, 'PUBLIC') AND privilege_type IN ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')) AS writes`);
          const row = r.rows[0];
          if (row?.powerful) return "the role is a superuser or can create roles and databases";
          if (row?.writes) return `the role can write: ${row.writes}`;
          if (row?.can_create) return "the role can create tables in the public schema (run REVOKE CREATE ON SCHEMA public FROM <role>; on Postgres 14 or older also FROM PUBLIC)";
          return null;
        });
      }
      return withMongo(secret, async (db) => {
        const status = await db.command({ connectionStatus: 1, showPrivileges: true }) as { authInfo?: { authenticatedUserPrivileges?: { resource: { db?: string; collection?: string }; actions: string[] }[] } };
        const WRITES = new Set(["insert", "update", "remove", "createCollection", "dropCollection", "dropDatabase", "createIndex", "dropIndex", "renameCollectionSameDB", "createUser", "grantRole"]);
        for (const p of status.authInfo?.authenticatedUserPrivileges ?? []) {
          const hit = p.actions.find((a) => WRITES.has(a));
          if (hit) return `the user can ${hit} on ${p.resource.collection || p.resource.db || "the cluster"}`;
        }
        return null;
      });
    },

    async query(kind: ConnectionKind, secret: string, req): Promise<Row[]> {
      if (kind === "postgres") {
        return withPg(secret, async (c) => {
          await c.query("BEGIN READ ONLY");
          try {
            const r = await c.query(`SELECT * FROM (${req.query}) AS bridge_result LIMIT ${Math.floor(req.limit)}`);
            return r.rows as Row[];
          } finally { await c.query("ROLLBACK").catch(() => {}); }
        });
      }
      const pipeline = JSON.parse(req.query) as Record<string, unknown>[];
      return withMongo(secret, async (db) => {
        const docs = await db.collection(req.datasets[0]!).aggregate([...pipeline, { $limit: Math.floor(req.limit) }], { maxTimeMS: QUERY_MS }).toArray();
        // ObjectIds, dates and decimals become plain strings and numbers.
        return JSON.parse(JSON.stringify(docs)) as Row[];
      });
    },
  };
}
