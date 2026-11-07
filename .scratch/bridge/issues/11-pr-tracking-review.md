# 11: PR tracking and Review screen

**What to build:** Each ticket produces one pull request titled with its ID. Bridge tracks PR status, moves cards to Review and Done, and only I can press Merge.

**Blocked by:** 03, 08

**Status:** ready-for-agent

Parent: .scratch/bridge/spec.md

- [ ] One PR per ticket with the ticket ID prefix, via the GitHub CLI
- [ ] Status polling moves cards to Review and Done
- [ ] The Review screen shows PR links and a merge control that only a human can trigger
- [ ] Local-only repos merge branches locally on approval
