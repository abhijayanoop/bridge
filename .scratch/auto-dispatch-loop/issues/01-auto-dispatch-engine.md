# 01: Auto-dispatch engine

**What to build:** A per-project `autoDispatch` setting, off by default and readable/writable through the API. When it is on, Bridge itself starts any ticket that is `ready-for-agent` with every blocker merged — through the exact same path a manual Start click uses today, so the worker cap, the queue, the rate-limit pause, the feature-gate hold, and the review stage all behave exactly as they already do. A ticket already running, already queued, or whose own auto-start attempt failed is never started or retried automatically. Merging a blocking ticket, and restarting Bridge, both re-evaluate readiness, since the dispatcher hooks into the same points that already drain the queue today.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

Parent: .scratch/auto-dispatch-loop/spec.md

- [x] A project's `autoDispatch` setting can be read and set through the API; it defaults to off
- [x] With it on, a ticket that is `ready-for-agent` and has every blocker done starts automatically, with no call to the manual start endpoint
- [x] A ticket that is blocked, held by an unapproved feature gate, already has a live agent, or is already queued is never auto-started a second time
- [x] Auto-started tickets respect the worker cap (extra ready tickets queue rather than over-starting) and the rate-limit pause (no automatic starts while paused, resuming once it lifts)
- [x] A ticket whose auto-start attempt itself fails is left for a human, the same as a failed manual start, and is not retried automatically
- [x] Merging a ticket's blocker causes its dependent to auto-start on its own, without any other trigger
- [x] On daemon restart with the setting already on, a ticket that was ready before the restart auto-starts after it
- [x] Turning the setting off stops further automatic starts; the ticket can still be started manually
- [x] Covered through the API seam with the fake agent adapter, extending the worker-cap-queue and restart-resume test patterns
