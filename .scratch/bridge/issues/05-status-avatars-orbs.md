# 05: Status hooks, avatars and orbs

**What to build:** Each agent has a coloured avatar in a unique shape whose animation shows its state, with a tinted thinking-orb. State comes from hooks reported by the agent, not from parsing terminal text.

**Blocked by:** 04

**Status:** ready-for-agent

Parent: .scratch/bridge/spec.md

- [ ] Hooks report idle, working, blocked, waiting and done to the daemon
- [ ] Eight avatar shapes and nine states render per the design, in the agent's colour; the lead is larger with a ring
- [ ] The thinking-orb is a vendored, colour-tinted fork with the MIT licence retained, mapped to states per the spec
- [ ] Reduced-motion preferences are respected
