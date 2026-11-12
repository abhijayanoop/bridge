import type { ConnectionKind } from "./datasource.ts";

export interface SetupStep { title: string; where: string; run: string }

const IDENT = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
export const validIdentifier = (s: unknown): s is string => typeof s === "string" && IDENT.test(s);

/**
 * The steps that create a read-only database role, shown to the user to run themselves with their own admin access.
 * Bridge runs nothing and never holds admin credentials. Every name is checked first, so the text is safe to paste.
 */
export function roleSetupSteps(input: { kind: ConnectionKind; database: string; role: string; tables?: string[] }): SetupStep[] {
  const { kind, database, role } = input;
  if (kind === "mongodb") {
    return [
      {
        title: "Create a user that can only read this database", where: "mongosh, connected as an admin user",
        run: `db.getSiblingDB("admin").createUser({ user: "${role}", pwd: passwordPrompt(), roles: [{ role: "read", db: "${database}" }] })`,
      },
      {
        title: "Copy the connection string", where: "Bridge, Analyst screen",
        run: `mongodb+srv://${role}:<the password you just typed>@<your cluster host>/${database}?authSource=admin`,
      },
    ];
  }
  const tables = (input.tables ?? []).filter(validIdentifier);
  const grant = tables.length ? `GRANT SELECT ON ${tables.join(", ")} TO ${role};` : `GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${role};`;
  return [
    {
      title: "Create the role", where: "psql or the Supabase SQL editor, as an admin",
      run: `CREATE ROLE ${role} LOGIN PASSWORD '<choose a strong password>';`,
    },
    {
      title: "Make every session of that role read-only", where: "the same session",
      run: `ALTER ROLE ${role} SET default_transaction_read_only = on;`,
    },
    {
      title: "Stop it creating objects", where: "the same session",
      run: `REVOKE CREATE ON SCHEMA public FROM ${role};\nREVOKE CREATE ON DATABASE ${database} FROM ${role};`,
    },
    {
      title: tables.length ? "Let it read only the tables you chose" : "Let it read the public schema",
      where: "the same session",
      run: `GRANT CONNECT ON DATABASE ${database} TO ${role};\nGRANT USAGE ON SCHEMA public TO ${role};\n${grant}`,
    },
    {
      title: "Copy the connection string", where: "Bridge, Analyst screen",
      run: `postgres://${role}:<the password you chose>@<host>:5432/${database}`,
    },
  ];
}
