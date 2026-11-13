# 02: Toggle and provenance in the UI

**What to build:** A switch in the top bar, next to the existing worker-cap control, that turns auto-dispatch on or off for the active project, reflecting and persisting that project's own setting from ticket 01. An agent the dispatcher started by itself is visibly marked as such, on its card and in its terminal, so it can always be told apart from one started by a click.

**Blocked by:** 01

**Status:** ready-for-agent

Parent: .scratch/auto-dispatch-loop/spec.md

- [ ] A toggle next to the worker cap in the top bar turns auto-dispatch on and off for the active project
- [ ] The toggle shows the project's current setting on load and after a reload
- [ ] Switching between projects shows each project's own toggle state, independent of the others
- [ ] An agent started by the dispatcher is visibly distinguished from a manually started one, on its card and in its terminal
- [ ] Covered by a test asserting the setting round-trips through the toggle and the provenance marker appears on an auto-started agent
