# 10: Worker cap and queue

**What to build:** At most 2 workers run in parallel (raisable to 3), extra tickets queue, a rate limit pauses the queue, and the lead's suggested worker count is shown.

**Blocked by:** 04, 08

**Status:** done

Parent: .scratch/bridge/spec.md

- [x] The cap is enforced and configurable up to 3
- [x] Tickets beyond the cap wait and start as slots free up, respecting blockers
- [x] A detected rate limit pauses the queue and shows a warning
- [x] The top bar shows workers against cap
