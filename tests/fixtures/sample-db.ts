/** A seeded sample database. Every value is invented; no real data is ever used in tests. */
export const SAMPLE_CONNECTION_STRING = "postgres://bridge_analyst:s3cret-sample-pw@db.example.invalid:5432/shop";

export const SAMPLE_TABLES: Record<string, Record<string, unknown>[]> = {
  customers: [
    { id: 1, name: "Ada Lovelace", email: "ada@example.invalid", city: "London", invoices_per_year: 12 },
    { id: 2, name: "Alan Turing", email: "alan@example.invalid", city: "Wilmslow", invoices_per_year: 4 },
    { id: 3, name: "Ada Lovelace", email: "ada.l@example.invalid", city: "London", invoices_per_year: 2 },
  ],
  invoices: [
    { invoice_id: "inv-1", customer_id: 1, total: 120 },
    { invoice_id: "inv-2", customer_id: 2, total: 80 },
  ],
  secrets: [{ key: "api", value: "should-never-be-reachable" }],
};
