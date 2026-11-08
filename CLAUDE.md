## Agent skills

### Issue tracker

Issues and specs are local markdown files under `.scratch/<feature>/`. See `docs/agents/issue-tracker.md`.

### Triage labels

Default five-role vocabulary (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `GLOSSARY.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.

## Resuming the build

When the user says "resume Bridge" (or asks to continue building), read `docs/orchestration.md` and follow its loop. Progress lives in `.scratch/bridge/issues/` (acceptance boxes) and `git log` on `main`. A ticket is done when its boxes are ticked and its branch is merged. Pick the lowest-numbered ticket whose blockers are all done; ticket 04 has a manual check left for the user. Stop when the user says to.
