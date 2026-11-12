import { sensitiveWord, type Row } from "./masking.ts";

export type ConnectionKind = "postgres" | "mongodb";
export const CONNECTION_KINDS: readonly ConnectionKind[] = ["postgres", "mongodb"];

/** A table or collection the Analyst can ask about. Only names, never data. */
export interface Dataset { name: string; columns: string[] }

/**
 * The host-side door to a real database. The connection string is passed in per call by the daemon and is never
 * stored here. Implementations must open the connection read-only; the daemon also checks every query first.
 */
export interface DataSource {
  datasets(kind: ConnectionKind, secret: string): Promise<Dataset[]>;
  /** `query` is a SELECT for Postgres, a JSON aggregation pipeline for MongoDB. Resolves with at most `limit` rows. */
  query(kind: ConnectionKind, secret: string, req: { datasets: string[]; query: string; limit: number }): Promise<Row[]>;
  /** Looks at what the role may do. Resolves with why it is NOT read-only (e.g. "can INSERT into orders"), or null when it is. */
  writeAccess(kind: ConnectionKind, secret: string): Promise<string | null>;
}

export type Checked = { ok: true; query: string } | { ok: false; reason: string };

const WRITE_WORDS = /\b(insert|update|delete|drop|alter|create|grant|revoke|truncate|copy|call|do|execute|exec|merge|vacuum|reset|lock|into|set|listen|notify|prepare|comment|refresh|reindex|cluster|analyze|explain|table|values)\b/i;
const DANGEROUS_FN = /\b(pg_\w+|lo_\w+|dblink\w*|set_config|current_setting|query_to_xml\w*|xmlforest|nextval|setval)\s*\(/i;
/** Pipeline stages the Analyst may use. Anything else, including stages added by later MongoDB versions, is refused. */
const MONGO_STAGES = new Set(["$match", "$project", "$group", "$sort", "$limit", "$skip", "$count", "$unwind", "$addFields", "$set", "$unset", "$sample", "$bucket", "$bucketAuto", "$sortByCount", "$replaceRoot", "$replaceWith"]);
const MONGO_BANNED = new Set(["$function", "$accumulator", "$where"]);
const MAX_STAGES = 12;
/** A join condition that only compares two columns reveals nothing, so it may name identifier columns. */
const PLAIN_JOIN = /^on\s+[\w.]+\s*=\s*[\w.]+(?:\s+and\s+[\w.]+\s*=\s*[\w.]+)*$/i;

const REASON_MASK = "while masking is on, names and identifiers may only be selected as plain columns (no AS, no functions, no WHERE, no counting them); use count(*), or select other columns";

function checkPostgres(datasets: string[], query: string, masked: boolean): Checked {
  const allowed = new Set(datasets.map((d) => d.toLowerCase()));
  // Quoting hides what the scans below look for, so it is refused: write plain lower-case names.
  if (/["$\\]/.test(query)) return { ok: false, reason: "double quotes, dollar quoting and backslashes are not allowed: use plain lower-case table and column names" };
  const stripped = query.replace(/'(?:[^']|'')*'/g, "''");
  if (/--|\/\*/.test(stripped)) return { ok: false, reason: "comments are not allowed in a query" };
  const body = stripped.trim().replace(/;\s*$/, "");
  if (body.includes(";")) return { ok: false, reason: "only one statement is allowed" };
  if (!/^select\b/i.test(body)) return { ok: false, reason: "only a plain SELECT is allowed (no WITH, no writes)" };
  if (WRITE_WORDS.test(body)) return { ok: false, reason: "the query contains a word that is not allowed in a read-only query" };
  if (DANGEROUS_FN.test(body)) return { ok: false, reason: "that function is not allowed" };
  // EXTRACT(year FROM col) and IS DISTINCT FROM use FROM without naming a table.
  const scan = body.replace(/\bextract\s*\(\s*\w+\s+from\b/gi, "extract(x,").replace(/\bdistinct\s+from\b/gi, "distinct,");
  if (/\b(?:from|join)\s+[^\s,;()]+(?:\s+(?:as\s+)?\w+)?\s*,/i.test(scan)) return { ok: false, reason: "list each table with JOIN, not a comma" };
  for (const m of scan.matchAll(/\b(?:from|join)\s+([^\s,;()]+)/gi)) {
    const parts = m[1]!.toLowerCase().split(".");
    if (parts.length > 2 || (parts.length === 2 && parts[0] !== "public")) return { ok: false, reason: `table ${m[1]} is not among the datasets named for approval (only the public schema is allowed)` };
    if (!allowed.has(parts.at(-1)!)) return { ok: false, reason: `table ${parts.at(-1)} is not among the datasets named for approval` };
  }
  if (masked) {
    // Masking works on result column names, so an alias or expression around a name would unmask it.
    const joinsRemoved = scan.replace(/\bon\b[\s\S]*?(?=\b(?:join|left|right|inner|outer|cross|full|where|group|order|having|limit)\b|$)/gi, (on) => (PLAIN_JOIN.test(on.trim()) ? " " : on));
    for (const m of joinsRemoved.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)) {
      if (!sensitiveWord(m[0])) continue;
      const before = joinsRemoved.slice(0, m.index).trimEnd().toLowerCase();
      const after = joinsRemoved.slice(m.index + m[0].length).trimStart().toLowerCase();
      const prevOk = /(?:\bselect|\bdistinct|\bby|\bfrom|\bjoin|,|\.)$/.test(before);
      const nextOk = /^(?:,|from\b|order\b|limit\b|desc\b|asc\b|having\b|$)/.test(after);
      if (!prevOk || !nextOk) return { ok: false, reason: REASON_MASK };
    }
  }
  return { ok: true, query: body };
}

/** The field a `$path` string or object key points at, or null for a value that is not a field reference. */
const fieldOf = (s: string) => (s.startsWith("$$") ? null : s.replace(/^\$/, "").split(".").pop() ?? null);

/** True when any key or `$field` reference in this pipeline fragment names a sensitive column. */
function mentionsSensitive(v: unknown): boolean {
  if (typeof v === "string") { const f = v.startsWith("$") ? fieldOf(v) : null; return !!f && !!sensitiveWord(f); }
  if (Array.isArray(v)) return v.some(mentionsSensitive);
  if (v && typeof v === "object") {
    return Object.entries(v).some(([k, x]) => (!k.startsWith("$") && !!sensitiveWord(k)) || mentionsSensitive(x));
  }
  return false;
}

function checkMongo(datasets: string[], query: string, masked: boolean): Checked {
  if (datasets.length !== 1) return { ok: false, reason: "a MongoDB query uses exactly one collection" };
  let parsed: unknown;
  try { parsed = JSON.parse(query); } catch { return { ok: false, reason: "the query must be a JSON aggregation pipeline, e.g. [{\"$match\":{}}]" }; }
  if (!Array.isArray(parsed) || parsed.some((s) => !s || typeof s !== "object" || Array.isArray(s) || Object.keys(s).length !== 1)) return { ok: false, reason: "the query must be a JSON array of pipeline stages, each with one operator" };
  if (parsed.length > MAX_STAGES) return { ok: false, reason: `at most ${MAX_STAGES} pipeline stages` };
  const banned = (v: unknown): string | null => {
    if (Array.isArray(v)) { for (const x of v) { const b = banned(x); if (b) return b; } return null; }
    if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { if (MONGO_BANNED.has(k)) return k; const b = banned(x); if (b) return b; }
    return null;
  };
  for (const stage of parsed as Record<string, unknown>[]) {
    const [op, body] = Object.entries(stage)[0]!;
    if (!MONGO_STAGES.has(op)) return { ok: false, reason: `${op} is not allowed: Analyst queries are read-only and stay on one collection` };
    const bad = banned(body);
    if (bad) return { ok: false, reason: `${bad} is not allowed` };
    if (!masked) continue;
    const refuse = { ok: false as const, reason: REASON_MASK };
    if (op === "$sort" || op === "$limit" || op === "$skip" || op === "$count" || op === "$sample") continue;
    if (op === "$project" && body && typeof body === "object") {
      for (const [k, v] of Object.entries(body)) {
        const plain = v === 0 || v === 1 || v === true || v === false;
        if (sensitiveWord(k.split(".").pop()!) && !plain) return refuse;
        if (!plain && mentionsSensitive(v)) return refuse;
      }
      continue;
    }
    if (op === "$group" && body && typeof body === "object") {
      for (const [k, v] of Object.entries(body)) if (k !== "_id" && mentionsSensitive(v)) return refuse;
      continue;
    }
    if (mentionsSensitive(body)) return refuse;
  }
  return { ok: true, query };
}

/**
 * Host-side guard run on every Analyst query before it reaches the database. It is defence in depth: the real
 * boundary is the read-only database role. It accepts one plain SELECT (or one find/aggregate pipeline) that touches
 * only the datasets the user was asked to approve and, while masking is on, cannot reshape a name or identifier
 * column so that masking by column name would miss it.
 */
export function checkReadOnly(kind: ConnectionKind, datasets: string[], query: string, masked = true): Checked {
  if (datasets.length === 0) return { ok: false, reason: "name the dataset or datasets the query uses" };
  return kind === "mongodb" ? checkMongo(datasets, query, masked) : checkPostgres(datasets, query, masked);
}

/** Removes a secret from text that is about to be shown to the agent or the user. */
export function scrub(text: string, secret: string): string {
  if (!secret) return text;
  let out = text.split(secret).join("[redacted]");
  // The password inside a connection string can show up on its own.
  const pw = secret.match(/^[a-z][a-z0-9+.-]*:\/\/[^:@/]*:([^@/]+)@/i)?.[1];
  if (pw) {
    let decoded = pw;
    try { decoded = decodeURIComponent(pw); } catch { /* not percent-encoded */ }
    out = out.split(decoded).join("[redacted]").split(pw).join("[redacted]");
  }
  return out;
}

/** A database error with every quoted value removed: errors such as `invalid input syntax for "John Smith"` echo row data. */
export function withoutValues(text: string): string {
  return text.replace(/"[^"]*"|'[^']*'|\([^()]*\)=\([^()]*\)/g, "…");
}
