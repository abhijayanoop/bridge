# Manual check: Analyst against a real database engine

`npm test` covers the Analyst with a seeded in-memory data source and never touches a network. This check covers what the tests cannot: the real `pg` and `mongodb` drivers and, with Docker Sandboxes, that no credential reaches the sandbox. **Use a throwaway database seeded with invented data. Never real data.**

## Setup (about five minutes)

1. Start a throwaway database you can delete, for example `docker run --rm -e POSTGRES_PASSWORD=admin -p 5433:5432 postgres:16`, then create a database `shop` with tables `customers(id, name, email, city)` and `invoices(invoice_id, customer_id, total)` holding made-up rows.
2. Start Bridge (`npm start`) and open the **Analyst** screen.
3. **Add a connection**, choose Postgres, database `shop`, role `bridge_analyst`, tables `customers, invoices`. Run the steps it shows in `psql` as the admin. Paste `postgres://bridge_analyst:<password>@localhost:5433/shop` and press **Test and save**.
4. Repeat for MongoDB if you want that engine checked (`mongosh` step shows a `read` role).

## What to confirm

- [ ] The Analyst card says the Analyst is off and **Start the Analyst** is disabled until you tick **Enabled**.
- [ ] After enabling, start it with a question such as "How many customers per city?". An Inbox card "Read shop/customers (read-only)" appears with the query and "masked".
- [ ] Approve once. The answer contains cities and counts but no real-looking names or emails (they appear as `name-1`, `email-2`).
- [ ] Ask it to change data ("delete customer 1"). The tool refuses; even if you try the query by hand against the role, `psql -U bridge_analyst` reports `cannot execute DELETE in a read-only transaction` or `permission denied`.
- [ ] Ask about `invoices` without approving it first: a second Inbox card appears; deny it and nothing runs.
- [ ] Untick **Mask names and identifiers**: the screen shows a warning, and results then show raw names.
- [ ] The file `~/.bridge/secrets/<id>` holds the connection string; `~/.bridge/bridge.db` does not (`grep` it).
- [ ] With Docker Sandboxes (`sbx`) running, open a shell in the Analyst's sandbox and run `env`: no connection string, and `~/.bridge` is not mounted.

## Known limits

- In **local mode** (no sandbox) the Analyst shares your computer. The secrets folder is owner-only on macOS and Linux, but on Windows the file inherits the folder's permissions, and an agent that you allow to read files could read it. The Analyst's instructions tell it not to, and local mode keeps permission prompts on, but real data belongs behind Docker Sandboxes. The API warns about this when it starts an Analyst in local mode.
- The SQL guard is defence in depth (one plain `SELECT`, only the approved tables, no comments or writes). The real boundary is the read-only role, which is why the wizard grants `SELECT` on only the tables you list.
- Masking works on result column names and email-looking text. While it is on, a query may only select name and identifier columns as plain columns (no `AS`, no functions, no `WHERE name = ...`, no `count(email)`; `count(*)` and joins on `a.id = b.customer_id` are fine), so it cannot rename a column past the mask. A free-text column that happens to contain a name is still not masked; approve datasets with that in mind.
- Quoted identifiers, dollar quoting and backslashes are refused, so tables and columns need plain lower-case names. Only the `public` schema is reachable.
- When you save a connection, Bridge checks what the role may do and refuses one that can write, create objects or is a superuser. Add to the checks above: paste a connection string for an admin role and confirm it is rejected with "not read-only".
