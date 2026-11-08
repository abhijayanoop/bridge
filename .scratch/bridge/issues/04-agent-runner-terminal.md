# 04: Agent runner and live terminal

**What to build:** I can start an agent on a ticket and watch it in a live terminal drawer, type into it, and stop it with one control. Works with the fake adapter in tests and the real Claude Code CLI on my subscription login.

**Blocked by:** 03

**Status:** ready-for-agent

Parent: .scratch/bridge/spec.md

- [x] Starting an agent on a ticket launches it and streams its terminal to the UI
- [x] Typing in the terminal reaches the agent; Stop halts it
- [x] Permission prompts and questions are visible in the terminal
- [ ] Works on Windows 11 with the real CLI (manual check) and with the fake adapter (automated)

Note: real-CLI-on-Windows manual check is not yet done; see docs/manual-check-real-cli.md.
