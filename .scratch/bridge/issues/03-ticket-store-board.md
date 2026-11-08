# 03: Ticket store and Board

**What to build:** The Board shows the repo's ticket files as cards in Backlog, In progress, Review and Done. Changing a card's status writes back to the ticket file.

**Blocked by:** 02

**Status:** ready-for-agent

Parent: .scratch/bridge/spec.md

- [x] Ticket files in the repo are read into the Board with ID, title, assigned agent, blockers and status
- [x] Status changes made in Bridge are written to the ticket file, and edits to the file appear in Bridge
- [x] Blocked tickets are visibly blocked until their blockers are done
- [x] Behaviour is covered through the API seam
