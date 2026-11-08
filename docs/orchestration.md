# Build orchestration (resume notes)

Use this when a session is cleared or restarted. State lives in files and git, not in chat.

## The loop

1. Read `.scratch/bridge/issues/` and `git log`. A ticket is done when its acceptance boxes are ticked and its branch is merged into `main`.
2. Pick the lowest-numbered ticket whose blockers are all done. Create branch `ticket/NN-slug` from `main`.
3. Start a fresh subagent for that one ticket. Give it: the ticket file, `.scratch/bridge/spec.md`, `CLAUDE.md`, `docs/testing.md`, and the rules below.
4. When it reports, re-run `npm test`, `npm run typecheck` and `npm run build` yourself. If they pass, fast-forward merge the branch into `main` and go to step 1. If a ticket fails twice, note why at the bottom of its file under `## Comments` and move to another unblocked ticket.

## Rules for every worker

- Work only in this folder. TDD through the public API seam using the fake agent and sandbox.
- No global installs, no `sbx` or Docker changes, no pushing, never read real `.env` files.
- Use Write/Edit for files. Commit with the Co-Authored-By and Claude-Session lines.
- Docker Desktop and `sbx` are needed only to verify ticket 09 and parts of 17 manually.

## Approvals

Ask the user through a question prompt and a push notification (Remote Control, mobile). Needed for: installing sbx, pushing to GitHub, deleting anything, anything outside this folder.
