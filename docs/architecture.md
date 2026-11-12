# Architecture

One global **daemon** (TypeScript on Node) serves a React/Vite/Tailwind UI over HTTP and WebSocket. The `/bridge` skill and `bin/bridge.mjs` only start or reuse the daemon and open the browser. State lives in SQLite (agents, runs, approvals) and in the repo's own ticket files (`.scratch/<feature>/issues/*.md`); there is no separate ticket database.

## Modules (`src/server`)

| Module | Role |
| --- | --- |
| `daemon.ts` | HTTP/WS API, worker cap and queue, rate-limit pause. The only test seam. |
| `agent-runner.ts`, `pty-agent.ts`, `fake-agent.ts` | Start, stop and observe agents through an adapter. Real agents are the interactive Claude CLI in a pseudo-terminal; tests use a scripted fake. |
| `sbx.ts`, `workspace.ts` | Sandbox port: Docker Sandboxes first, local-clone mode as fallback. One fresh clone per worker. |
| `approvals.ts`, `inbox.ts` | Permission broker (Once / Ticket / Project, undoable) and the Inbox. |
| `agent-tools.ts`, `hooks.ts` | MCP tools for agents (get ticket, set status, ask user, request access) and status hooks written into each workspace. |
| `tickets.ts`, `features.ts` | Ticket store and the lead pipeline gates. |
| `pull-requests.ts`, `github.ts`, `reviewer.ts`, `review-stage.ts` | PR tracking over the GitHub CLI and the code-review stage. Merging is refused. |
| `connections.ts`, `datasource*.ts`, `masking.ts`, `analyst-setup.ts` | Analyst: host-side read-only queries, masking, per-dataset approval. |

## UI (`web`)

Board, Agents (terminal drawer), Inbox, Plan, Review, Analyst, command palette, first-run setup and new-project dialog. Avatars and the canvas orb are driven by the nine agent states in `src/shared/avatar.ts`. The UI is rebuilt from the Claude Design canvas saved in `design-source/`.

## Testing

Tests drive the daemon's public API with fake agent, sandbox, GitHub and datasource adapters. See [testing.md](testing.md).
