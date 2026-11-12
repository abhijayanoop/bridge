import type { DataSource, Dataset } from "./datasource.ts";
import type { Row } from "./masking.ts";

export interface FakeDataSource extends DataSource {
  /** Every call that reached the data source, with the credential it was given (so tests can prove it stayed on the host). */
  calls: { kind: "datasets" | "query"; secret: string; query?: string }[];
  /** Makes every following call fail with this message. */
  failWith(message: string | null): void;
  /** Makes the write-access check report that the role is not read-only. */
  canWrite(why: string | null): void;
}

/** An in-memory data source over seeded tables. Used by tests and the fake agent; never touches a network. */
export function createFakeDataSource(tables: Record<string, Row[]>): FakeDataSource {
  let failure: string | null = null;
  let writeWhy: string | null = null;
  const calls: FakeDataSource["calls"] = [];
  return {
    calls,
    failWith(message) { failure = message; },
    canWrite(why) { writeWhy = why; },
    async writeAccess() { return writeWhy; },
    async datasets(_kind, secret): Promise<Dataset[]> {
      calls.push({ kind: "datasets", secret });
      if (failure) throw new Error(failure);
      return Object.entries(tables).map(([name, rows]) => ({ name, columns: Object.keys(rows[0] ?? {}) }));
    },
    async query(_kind, secret, req) {
      calls.push({ kind: "query", secret, query: req.query });
      if (failure) throw new Error(failure);
      return (tables[req.datasets[0]!] ?? []).slice(0, req.limit).map((r) => ({ ...r }));
    },
  };
}
