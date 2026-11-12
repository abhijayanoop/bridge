/**
 * Masking for Analyst results. Runs on the host before anything reaches the agent, so the agent never sees who a
 * customer is. Identifying values become stable pseudonyms within one result (the same person is always `name-1`),
 * so grouping and counting still work. Counts, totals, cities and other non-identifying columns pass through.
 */
export type Row = Record<string, unknown>;

/** A column whose name has one of these words in it holds names or identifiers. */
const SENSITIVE = new Set([
  "name", "firstname", "lastname", "fullname", "surname", "username", "email", "phone", "mobile", "address", "street",
  "ssn", "passport", "dob", "birth", "birthday", "ip", "token", "secret", "password", "uuid", "guid", "iban", "card", "id", "ids",
]);
const EMAIL = /[^\s@"'<>]+@[^\s@"'<>]+\.[^\s@"'<>]+/;

const words = (key: string) => key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

/** The sensitive word in a column name (e.g. "name" for full_name), or null. */
export function sensitiveWord(key: string): string | null {
  const w = words(key);
  const joined = w.join("");
  return w.find((x) => SENSITIVE.has(x)) ?? (SENSITIVE.has(joined) ? joined : null);
}

/** Replaces names, identifiers and email-looking text in the rows with pseudonyms such as `name-1`. */
export function maskRows(rows: Row[]): Row[] {
  const seen = new Map<string, string>();
  const counters = new Map<string, number>();
  const alias = (word: string, value: unknown) => {
    const k = `${word}\u0000${typeof value}\u0000${String(value)}`;
    let a = seen.get(k);
    if (!a) {
      const n = (counters.get(word) ?? 0) + 1;
      counters.set(word, n);
      a = `${word}-${n}`;
      seen.set(k, a);
    }
    return a;
  };
  const mask = (value: unknown, inherited: string | null): unknown => {
    if (value === null || value === undefined) return value;
    if (Array.isArray(value)) return value.map((v) => mask(v, inherited));
    if (value instanceof Date) return inherited ? alias(inherited, value.toISOString()) : value;
    if (typeof value === "object") {
      const out: Row = {};
      for (const [k, v] of Object.entries(value as Row)) out[k] = mask(v, sensitiveWord(k) ?? inherited);
      return out;
    }
    if (inherited) return alias(inherited, value);
    if (typeof value === "string" && EMAIL.test(value)) return value.replace(new RegExp(EMAIL.source, "g"), (m) => alias("email", m));
    return value;
  };
  return rows.map((r) => mask(r, null) as Row);
}
