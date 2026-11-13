Status: ready-for-agent

# Auto-dispatch loop: starting tickets without a click

## Problem Statement

Once a feature is planned and sliced into tickets, I still have to go into the Agents screen, find the next ticket whose blockers are merged, and click Start on it myself — one ticket at a time, for the whole backlog. Bridge already runs each ticket in its own fresh clone and branch, already queues tickets when the worker cap is full, and already reviews each branch before it opens a pull request — but none of that fires until I manually kick a ticket off. For a feature with a dozen tickets, that means a dozen trips back to the Agents screen, each one just to say "yes, start this."

## Solution

Bridge gains a per-project auto-dispatch mode. When it's on, the moment a ticket becomes `ready-for-agent` with every blocker merged, Bridge starts it itself — through the exact same path a manual click uses today, so the worker cap, the queue, the rate-limit pause, the code-review stage, and restart/resume all behave exactly as they already do. Merging stays mine alone: a ticket's blocker only clears when I merge its predecessor, so the loop advances automatically between merges but always stops and waits for me at the merge gate. A ticket whose review stays unresolved after the existing retry limit doesn't stall the rest of the board — its pull request just sits in Review while every other unblocked ticket keeps auto-starting. I can turn the mode off per project at any time and go back to starting tickets by hand.

## User Stories

1. As a developer, I want Bridge to automatically start a ticket the moment it becomes ready and unblocked, so that I never have to click Start myself.
2. As a developer, I want the dispatcher to only act on tickets already marked `ready-for-agent` with every blocker merged, so that untriaged or not-yet-approved tickets never start themselves.
3. As a developer, I want the dispatcher to feed tickets through the exact same start path a manual click uses, so that cap, queue, rate-limit pause, sandboxing, and review behave identically whether a ticket started by my hand or on its own.
4. As a developer, I want the dispatcher to react to the same events that already free a slot or resolve a blocker (an agent finishing, a merge, a cap change, a ticket flipping to `ready-for-agent`), so that there's no new polling timer silently running in the daemon.
5. As a developer, I want a ticket that just got merged to immediately unblock its dependents and auto-start them if a slot is free, so that a whole chain of tickets can run to completion without me touching anything between merges.
6. As a developer, I want merging to remain something only I do, so that nothing lands on `main` without my review, loop or no loop.
7. As a developer, I want the code-review stage (Standards versus Spec, routed back to the author, capped rounds, fail-open to an open pull request) to run completely unchanged under auto-dispatch, so that quality gates aren't weakened just because a ticket started itself.
8. As a developer, I want a ticket whose review stays unresolved after the retry cap to just sit in Review with its pull request open, so that it doesn't block the dispatcher from starting other unblocked tickets.
9. As a developer, I want the existing worker cap to remain the only concurrency throttle, so that auto-dispatch doesn't need a second, separate limit.
10. As a developer, I want the existing rate-limit pause to also pause auto-dispatch, so that a detected usage limit stops new tickets from starting themselves, not only ones already queued.
11. As a developer, I want to turn auto-dispatch off per project, so that I can fall back to starting tickets one at a time when I want tighter control over a sensitive piece of work.
12. As a developer, I want to see at a glance whether auto-dispatch is on for the current project, so that I'm never surprised by a ticket starting itself.
13. As a developer, I want to tell an automatic start apart from one I triggered, so that I can audit what the loop did versus what I did.
14. As a developer, I want restart and resume to keep working unchanged with auto-dispatch on, so that a Bridge restart resumes in-flight tickets and the dispatcher picks back up evaluating readiness from there.
15. As a developer, I want the dispatcher to never touch a ticket whose blockers aren't all merged, so that dependency ordering stays exactly as reliable as it is today.
16. As a developer, I want a ticket that fails to start (for example a clone failure) to not be retried in a tight automatic loop, so that a broken ticket waits for me the same way a failed manual start would, instead of spamming retries.
17. As a developer, I want the Inbox and push notification to stay the one place anything needing me shows up (a merge, a stuck review, an access request), so that auto-dispatch doesn't need a separate notification channel of its own.
18. As a developer, I want the toggle to apply per project, so that a workspace holding several repos can run the loop on one and leave another on manual start.
19. As a developer, I want auto-dispatch to re-evaluate every ready ticket on daemon startup, so that toggling it on for the first time (or restarting with it already on) catches tickets that were ready all along, not only ones that become ready afterward.
20. As a developer, I want the three lead-pipeline gates (spec, tickets, merge) left exactly as they are, so that auto-dispatch only ever removes the per-ticket Start click, never the planning or merge approvals that keep me in control.

## Implementation Decisions

- **New capability, not a new pipeline.** The dispatcher is a thin layer that watches for readiness and calls the same internal start-a-ticket operation the manual Start action already calls. It introduces no second queue, no second review mechanism, and no second PR flow — every ticket it starts goes through the identical cap, queue, sandbox, review-stage, and PR path as one started by hand.
- **Trigger points, not a timer.** The dispatcher re-evaluates readiness at the same moments the daemon already reacts to: a worker finishing its ticket and freeing a slot, a ticket's blocker being merged, the worker cap changing, a ticket's status transitioning to `ready-for-agent`, and daemon startup (to catch tickets that were already ready). No polling loop is added.
- **Readiness definition.** A ticket is dispatchable when its status is `ready-for-agent`, every ticket it is blocked by has status `done` (merged), and it is not already running or already queued. This mirrors the existing definition of "unblocked" used by the queue today.
- **Per-project toggle.** Auto-dispatch is a project-level setting, off by default, stored and surfaced the same way the existing worker-cap setting is — visible and switchable from the same area of the UI that shows the cap. Switching it off at any time stops future automatic starts but does not touch tickets already running or queued.
- **Merge gate is untouched.** The dispatcher never merges and never bypasses the merge approval. A ticket's blocker clears only on merge, exactly as today; the loop's only effect is removing the need for a manual click once that merge has already happened.
- **Fail-open is untouched.** When the review stage exhausts its retry rounds on a ticket, that ticket's pull request opens unresolved exactly as it does today. The dispatcher simply continues evaluating every other ticket's readiness; it does not treat the stuck ticket as blocking anything except its own direct dependents.
- **Rate-limit interaction.** A detected rate limit pauses the dispatcher exactly as it already pauses the queue — no ticket is auto-started while the plan's usage limit is in effect, and normal operation resumes automatically once the pause lifts.
- **Failed starts don't retry automatically.** If the start operation itself fails (for example, a clone error), the ticket is left in the same queued-with-error state a failed manual start leaves it in today, and the dispatcher does not re-attempt it; a human looks at it, the same as today.
- **Visible provenance.** A ticket started by the dispatcher is distinguishable in the UI from one started by hand (for example, a note on the ticket's card or in its agent terminal), so an automatic start can always be told apart from a manual one after the fact.
- **No change to the lead pipeline's gates.** The spec gate and the tickets gate are unaffected; this feature only concerns what happens to already-approved tickets after they exist.

## Testing Decisions

- **Same seam as the rest of Bridge.** Tests drive the daemon's public HTTP/WebSocket API against a temporary directory and database, with the fake agent-runner adapter (and fake sandbox/GitHub CLI where relevant) standing in for real agents, following the existing pattern.
- **The behavior worth pinning down is absence of a call.** Where existing tests call the manual start endpoint to get a ticket running, this feature's tests must prove a ticket starts *without* that call once it becomes ready and unblocked — observed through the same status/WebSocket stream the UI uses.
- **Scenarios to cover:**
  - A ticket that is `ready-for-agent` and unblocked starts on its own with no start call.
  - Merging a blocking ticket immediately makes its dependent auto-start, if a slot is free.
  - Auto-dispatch respects the worker cap: extra ready tickets queue rather than over-starting.
  - Auto-dispatch respects a rate-limit pause: no automatic starts occur while paused, and they resume once the pause lifts.
  - Toggling auto-dispatch off for a project stops further automatic starts; the same ticket can still be started manually.
  - A ticket whose review stays unresolved after the retry cap does not prevent other unblocked tickets from auto-starting.
  - On daemon restart with auto-dispatch already on, a ticket that was ready before the restart auto-starts after it.
  - A ticket that fails to start is left for a human and is not auto-retried.
- **Prior art.** `tests/worker-cap-queue.test.ts`, `tests/code-review-stage.test.ts`, and `tests/restart-resume.test.ts` are the closest existing patterns and should be extended rather than duplicated.

## Out of Scope

- Automatic merging, under any circumstance — unchanged from Bridge's original spec.
- Any new or separate concurrency limit beyond the existing worker cap.
- Any new polling loop or timer.
- Any new notification channel outside the existing Inbox and push notification.
- Any change to the review stage's retry limit or fail-open behavior.
- Any change to the lead pipeline's spec or tickets gates.
- Cross-project auto-dispatch coordination beyond what the existing single daemon already provides (one toggle per project, independently).

## Further Notes

- This is additive to a completed, 18-ticket v1 and should land as its own new ticket(s) rather than reopening any of 01–18.
- Defaulting the toggle to off per project is a judgment call; confirm at ticket-slicing time if an on-by-default (with an explicit opt-out) is preferred instead.
