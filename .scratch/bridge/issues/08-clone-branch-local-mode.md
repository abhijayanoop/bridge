# 08: Clone, branch and local mode

**What to build:** Each ticket runs in its own fresh clone on its own branch, never my working copy. Real env files are never copied, the clone gets throwaway env values, and my installed Pocock skills are copied in. A local mode without a sandbox keeps normal permission prompts.

**Blocked by:** 04

**Status:** done

Parent: .scratch/bridge/spec.md

- [x] A ticket start creates a clone and branch; my working copy is untouched
- [x] Real .env files are never present in a clone, covered by a test
- [x] Throwaway env values are generated, and Pocock skills are copied in
- [x] Local mode runs with permission prompts on

## Comments

Known limits (from review): a committed env file stays in the clone's git history, so only the working tree is clean; a ticket file that is uncommitted in the working copy is absent from the clone; clones are not yet deleted when an agent finishes; the agent still inherits the daemon's own environment.
