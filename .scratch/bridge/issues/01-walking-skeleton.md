# 01: Walking skeleton and test seam

**What to build:** Running the launcher starts a local Bridge daemon and opens a dark UI shell with the sidebar, top bar and design tokens. The daemon exposes a public API (HTTP and WebSocket) backed by SQLite, with a scripted fake agent adapter so behaviour can be tested end to end.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

Parent: .scratch/bridge/spec.md

- [ ] The `/bridge` skill starts the daemon (or reuses a running one) and opens the browser
- [ ] The UI shell renders in the dark theme from the design tokens
- [ ] An end-to-end test drives the public API with a fake agent adapter and temporary storage, and passes in the default test run
- [ ] The test pattern is documented so later tickets reuse it
