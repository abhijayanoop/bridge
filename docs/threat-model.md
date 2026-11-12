# Threat model

Bridge runs coding agents with full permissions inside a sandbox. The goal is that a misbehaving or prompt-injected agent can damage only its own throwaway clone.

## Assumptions

- Single user on their own machine. The daemon listens on localhost only.
- The user trusts their own repo and the skills they installed, but not what agents read from the web, dependencies or issue text.

## Controls

| Risk | Control |
| --- | --- |
| Agent damages the user's working copy | One sandbox per worker with a fresh clone, never the working copy. One ticket, one branch. |
| Secret leakage | Real `.env` files are never copied or mounted. Sandboxes get generated throwaway values. Real secrets live in the sandbox tool's store and are injected by proxy. |
| Data exfiltration | Network is default-deny. New domains, secrets, pushes and real-database access each need an Inbox approval (Once, Ticket or Project, undoable). Only Bridge's own network rules are removed. |
| Unreviewed code reaches main | Agents can open pull requests but cannot merge: the daemon refuses it unless the request comes from the Review screen (`x-bridge-ui`). |
| Analyst writes or leaks data | Off by default, enabled per connection. Read-only database role set up by the user's own admin steps. Credentials are held on the host and queried through a host-side tool; the sandbox never sees them. Names and identifiers are masked by default; each dataset needs approval. |
| Browser-origin attacks on the local API | State-changing quit requires the `x-bridge-ui` header. |
| Runaway cost | Worker cap (default 2, max 3), queue, rate-limit pause. Uses the Pro login, never API keys. |

## Known gaps

- Local-clone fallback mode is weaker than a real sandbox: agents run on the host with only a separate clone for isolation.
- Masking is pattern based and can miss identifiers in free text. Keep it on.
- The user's own approvals are the last line of defence; an approved "per Project" grant is broad.
- Windows 11 is the only platform exercised so far.
