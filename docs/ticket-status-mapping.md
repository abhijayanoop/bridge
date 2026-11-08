# Ticket files and the Board

The ticket files are the only source of truth. Bridge reads `<repo>/.scratch/<feature>/issues/NN-slug.md` on every request (no cache, no database copy) and watches `.scratch` to push a `tickets` WebSocket message when a file changes.

## File format

- Title: first `# ` heading, with a leading `NN:` removed.
- Metadata lines above the first `## ` heading: `Status:`, `Blocked by:`, and optionally `Agent:` or `Assigned to:`. Bold (`**Status:**`) and plain forms both work.
- `Blocked by:` lists ticket numbers in the same feature (`01, 02`) or `feature/NN` for another feature. `none` means no blockers.
- Ticket ID is `<feature>/<NN>`.

## Status to column

| Status value | Column |
| --- | --- |
| `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, missing or unknown | Backlog |
| `in-progress`, `claimed` | In progress |
| `in-review`, `review` | Review |
| `done`, `resolved`, `wontfix` | Done |

Changing a card's column writes: Backlog `ready-for-agent`, In progress `in-progress`, Review `in-review`, Done `done`. A ticket already in the target column is left untouched, so triage labels survive. If the file has no `Status:` line one is inserted. Line endings are preserved.

## Blocked

A ticket is blocked while any blocker is not in Done. A blocker that names a missing file never resolves. Done tickets are never shown as blocked. Acceptance checkboxes do not affect status.

## API

- `GET /api/projects/:id/tickets` returns tickets (`id`, `repoId`, `key`, `title`, `status`, `column`, `agent`, `blockers`, `blocked`, `file`).
- `POST /api/projects/:id/tickets/status` with `{ ticket, column }` writes the file.
