# 10: Worker cap and queue

**What to build:** At most 2 workers run in parallel (raisable to 3), extra tickets queue, a rate limit pauses the queue, and the lead's suggested worker count is shown.

**Blocked by:** 04, 08

**Status:** ready-for-agent

Parent: .scratch/bridge/spec.md

- [ ] The cap is enforced and configurable up to 3
- [ ] Tickets beyond the cap wait and start as slots free up, respecting blockers
- [ ] A detected rate limit pauses the queue and shows a warning
- [ ] The top bar shows workers against cap
