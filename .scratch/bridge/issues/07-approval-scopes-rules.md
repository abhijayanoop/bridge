# 07: Approval scopes and rules

**What to build:** Access requests are governed by rules: I can approve once, for a ticket, or for a project, and undo. Network domains, secrets, pushes and any real-database access need approval. Merging is never allowed.

**Blocked by:** 06

**Status:** ready-for-agent

Parent: .scratch/bridge/spec.md

- [ ] Once, Ticket and Project scopes behave as described and can be undone
- [ ] New network domains, secrets, pushes and database access require approval
- [ ] Any attempt by an agent to merge is refused, covered by a test
- [ ] Rules Bridge adds are tracked so only its own are removed
