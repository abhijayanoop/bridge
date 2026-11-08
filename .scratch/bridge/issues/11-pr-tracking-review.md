# 11: PR tracking and Review screen

**What to build:** Each ticket produces one pull request titled with its ID. Bridge tracks PR status, moves cards to Review and Done, and only I can press Merge.

**Blocked by:** 03, 08

**Status:** ready-for-agent

Parent: .scratch/bridge/spec.md

- [x] One PR per ticket with the ticket ID prefix, via the GitHub CLI
- [x] Status polling moves cards to Review and Done
- [x] The Review screen shows PR links and a merge control that only a human can trigger
- [x] Local-only repos merge branches locally on approval

## Comments

- Known gap: `POST /api/pulls/:id/merge` requires the `x-bridge-ui` header, which blocks web pages (a cross-origin request cannot add it without a preflight the daemon never allows). A local process, including an agent that can reach the daemon, can still set the header itself and merge. Agents have no Bridge tool for it and their own `git merge` / `gh pr merge` commands are refused, but closing the HTTP route needs real auth that an agent cannot read (the Inbox approve route has the same limit). Follow up before relying on "only a human can trigger" against a hostile agent.
- A closed (unmerged) pull request is recorded as closed and its card stays in Review; it is no longer polled.
