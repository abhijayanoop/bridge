# 09: Docker Sandboxes adapter

**What to build:** Workers run in a real Docker Sandbox with full permissions inside and approval-gated network and secrets outside. It sits behind the sandbox port so the fake still works in tests. Needs Docker Desktop and sbx installed, so final verification is manual.

**Blocked by:** 08

**Status:** ready-for-agent

Parent: .scratch/bridge/spec.md

- [ ] The sandbox port has a Docker Sandboxes implementation, selected when available; local mode otherwise
- [ ] Network rules and secrets are handled per the approval rules
- [ ] A manual check proves an agent runs in a sandbox with the subscription login on this machine
- [ ] A missing sbx produces a clear message and falls back to local mode
