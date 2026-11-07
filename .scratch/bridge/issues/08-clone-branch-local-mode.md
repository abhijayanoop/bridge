# 08: Clone, branch and local mode

**What to build:** Each ticket runs in its own fresh clone on its own branch, never my working copy. Real env files are never copied, the clone gets throwaway env values, and my installed Pocock skills are copied in. A local mode without a sandbox keeps normal permission prompts.

**Blocked by:** 04

**Status:** ready-for-agent

Parent: .scratch/bridge/spec.md

- [ ] A ticket start creates a clone and branch; my working copy is untouched
- [ ] Real .env files are never present in a clone, covered by a test
- [ ] Throwaway env values are generated, and Pocock skills are copied in
- [ ] Local mode runs with permission prompts on
