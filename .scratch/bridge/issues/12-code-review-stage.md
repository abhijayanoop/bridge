# 12: Code-review stage

**What to build:** The Pocock code-review skill reviews each branch for standards and spec. Findings are shown by severity in two columns and routed back to the author agent.

**Blocked by:** 06, 11

**Status:** done

Parent: .scratch/bridge/spec.md

- [x] The review runs before a ticket becomes ready to merge
- [x] Findings display as Standards versus Spec, by severity
- [x] Findings are sent back to the author agent as work to do
- [x] Covered through the API seam with a fake reviewer

## Comments

Decisions made while building, worth confirming:

- High and medium findings are sent back to the author; low ones are shown on the Review screen only.
- The author is sent back at most 2 rounds (`MAX_REVIEW_ROUNDS`). After that the review is marked "unresolved" and the pull request opens for the user to judge.
- Fail-open: if the reviewer cannot run (CLI missing, reply not in the expected JSON shape), the review is marked "failed", the agent's terminal says so, and the pull request still opens. The user merges, so nothing lands without them, but the gate is not hard.
- The real adapter (`createClaudeReviewer`) is checked by hand only: docs/manual-check-real-cli.md. It reviews a fresh checkout, with user-level settings only and file-changing tools denied. It depends on the model replying with the JSON shape the prompt asks for.

Left for ticket 15 (restart and resume):

- Per-agent state used by the review (clone path, base commit) is in memory. A review left running when Bridge stops is marked failed on the next start, but an agent that finishes after a restart goes straight to its pull request unreviewed.
- Pull requests opened before this stage existed do not pick up later commits from the author.
