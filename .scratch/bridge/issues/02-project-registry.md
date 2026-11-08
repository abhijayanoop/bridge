# 02: Project registry and switcher

**What to build:** I can open a repo (current folder or a path), Bridge remembers it across launches, and I can switch between projects in the UI. One daemon serves all projects.

**Blocked by:** 01

**Status:** ready-for-agent

Parent: .scratch/bridge/spec.md

- [x] Opening a repo registers it and it appears in the project switcher
- [x] Projects persist across daemon restarts
- [x] A second launch reuses the running daemon and adds or selects the project
- [x] The data model allows many repos per workspace, each ticket belonging to one repo
