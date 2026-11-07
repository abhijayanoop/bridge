Status: ready-for-agent

# Bridge: a local control room for a lead engineer and sandboxed worker agents

## Problem Statement

I do all my development through a terminal or the VS Code Claude extension. I use Matt Pocock's skills to plan and build features, but every step happens in a chat: I cannot see what several agents are doing at once, I cannot hand work to parallel agents safely, and I am afraid to give an agent full permissions because it could damage my codebase or touch a production database. Existing tools such as JSM HQ solve part of this but are complex to set up, do not use my skills, and have a UI I do not like.

## Solution

Bridge is a local web app launched from a Claude Code skill (`/bridge`) in any terminal or VS Code. It runs on my Claude Pro login. A lead engineer agent grills me, writes a spec, slices it into tickets and proposes how many worker agents to use. Each worker builds one ticket in its own sandboxed clone on its own branch, with full permissions inside the sandbox and nothing outside it. I watch every agent through a live terminal, a status avatar and a board, I answer their questions and approve their access requests in one Inbox, and I merge the resulting pull requests myself. The UI is a clean dark theme in which every agent has a coloured avatar whose animation shows its thinking state. A separate read-only Analyst agent can analyse real data with masking and per-connection approval.

## User Stories

1. As a developer, I want to type `/bridge` in any terminal, so that I can start my workflow without leaving where I already work.
2. As a developer, I want `/bridge` to ask which repo to work on (current folder, a path, or create new), so that I choose the project explicitly.
3. As a developer, I want `/bridge` to reuse an already-running Bridge server, so that I never start duplicates.
4. As a developer, I want the UI to open in my browser automatically, so that I land on the right project.
5. As a developer, I want one Bridge server to hold all my projects with a project switcher, so that I do not run a server per repo.
6. As a developer, I want to create a brand-new repo from the UI, with the lead scaffolding it after I approve, so that greenfield work uses the same flow.
7. As a developer, I want a first-run guided setup for a repo, so that the Pocock skills' tracker, labels and docs layout are configured once.
8. As a developer, I want Bridge to remember my projects between launches, so that I resume where I stopped.
9. As a developer, I want to describe a feature and have the lead grill me about it, so that the plan is sharp before any code is written.
10. As a developer, I want the lead to write a spec from that grilling, so that the plan is a durable document.
11. As a developer, I want to approve or reject the spec at a gate, so that nothing is built from a plan I have not accepted.
12. As a developer, I want the lead to slice the spec into tickets with blocking links, so that parallel work respects dependencies.
13. As a developer, I want to approve or reject the ticket breakdown at a gate, so that I control scope before agents start.
14. As a developer, I want the lead to suggest how many workers a feature needs, so that parallelism matches the work.
15. As a developer, I want a default cap of 2 parallel workers that I can raise to 3, so that my Pro plan limits are respected.
16. As a developer, I want queued tickets to wait when the cap is reached, so that I never exceed my limit by accident.
17. As a developer, I want tickets stored as files in my repo, so that I can read them without Bridge and they stay under version control.
18. As a developer, I want the board to read and write those ticket files, so that there is one source of truth.
19. As a developer, I want to see tickets as cards in Backlog, In progress, Review and Done, so that progress is visible at a glance.
20. As a developer, I want each card to show its ID, title, assigned agent, blockers and status, so that I know what each ticket is.
21. As a developer, I want each ticket to run in its own clone and branch, so that agents cannot collide.
22. As a developer, I want each worker to run inside a Docker Sandbox with full permissions, so that nothing outside the sandbox can be damaged.
23. As a developer, I want my real `.env` files never copied into a sandbox, so that production credentials cannot leak.
24. As a developer, I want each sandbox to receive throwaway environment values and a throwaway local database, so that agents can run the app safely.
25. As a developer, I want my installed Pocock skills copied into each worker's clone, so that workers use the same skills I do.
26. As a developer, I want a fallback local mode without a sandbox, with normal permission prompts, so that I can still work if the sandbox is unavailable.
27. As a developer, I want a live terminal for every agent, so that I can see exactly what it is doing.
28. As a developer, I want permission prompts and agent questions to appear in that terminal and in my Inbox, so that I never miss them.
29. As a developer, I want to type into an agent's terminal, so that I can answer or redirect it directly.
30. As a developer, I want to stop an agent with one control, so that I can halt runaway work.
31. As a developer, I want hook-based agent status (idle, working, blocked, waiting for me, done), so that the UI is accurate without parsing terminal text.
32. As a developer, I want an Inbox of everything that needs me (questions, access requests, plan approvals, ready-to-merge), so that I check one place.
33. As a developer, I want each Inbox item to show who is asking, what, and why, so that I can decide quickly.
34. As a developer, I want to approve a request once, for a ticket, or for a project, so that I choose how much trust to grant.
35. As a developer, I want to undo an approval, so that mistakes are recoverable.
36. As a developer, I want agents to be unable to merge, so that I stay in control of what lands.
37. As a developer, I want new network domains to need my approval, so that agents cannot reach arbitrary hosts.
38. As a developer, I want secrets and pushes to need my approval, so that nothing leaves the sandbox without my say.
39. As a developer, I want any real-database access to need my approval, so that production data stays protected.
40. As a developer, I want one pull request per ticket titled with the ticket ID, so that review and history map one-to-one.
41. As a developer, I want Bridge to track PR status, so that finished tickets move to Review and Done automatically.
42. As a developer, I want the Pocock `code-review` skill to review each branch for standards and spec, so that quality is checked before I merge.
43. As a developer, I want review findings shown by severity in two columns (Standards, Spec), so that I can judge them quickly.
44. As a developer, I want review findings routed back to the author agent, so that fixes happen without me relaying them.
45. As a developer, I want a merge button that I alone press, so that merging is a deliberate human act.
46. As a developer, I want the lead to pause at three gates (spec, tickets, merge), so that I stay in control between autonomous stretches.
47. As a developer, I want a read-only Analyst agent for real data, so that I can get analytics without risking writes.
48. As a developer, I want the Analyst off by default and enabled per connection, so that data access is a conscious choice.
49. As a developer, I want the Analyst to use a read-only database role and hold credentials outside the sandbox, so that it cannot write or leak secrets.
50. As a developer, I want names and identifiers masked by default in Analyst results, so that personal data is protected.
51. As a developer, I want a one-time guided setup for the read-only role on MongoDB and Postgres, so that I configure it correctly.
52. As a developer, I want every agent to have a coloured avatar in a unique shape, so that I can tell agents apart instantly.
53. As a developer, I want the lead to choose each agent's shape and colour when creating it, so that identity is automatic.
54. As a developer, I want avatar animation to reflect the agent's state (idle, planning, exploring, implementing, debugging, writing a PR, waiting, blocked, done), so that I read status without text.
55. As a developer, I want a small thinking-orb indicator in the agent's colour, so that activity is visible in compact spaces.
56. As a developer, I want a command palette with quick actions (architecture review, diagnose, research, prototype, triage, hand off), so that on-demand skills are one keystroke away.
57. As a developer, I want a Plan screen showing the spec, tickets with dependencies, and the gates, so that I can review the lead's work in one place.
58. As a developer, I want an Agents screen listing every agent with its ticket and status, so that I see the whole team.
59. As a developer, I want a top bar showing the project, branch, worker count against cap, rate-limit status and Inbox count, so that key state is always visible.
60. As a developer, I want Bridge to warn me before closing while agents are running, so that I do not lose work by accident.
61. As a developer, I want unfinished tickets to resume on the next launch, so that a restart is not a disaster.
62. As a developer, I want Bridge to pause the queue when my plan's rate limit is hit, so that agents do not fail noisily.
63. As a developer, I want a retro after a feature, so that lessons are captured.
64. As a developer, I want everything to work on Windows 11, so that it runs on my machine.
65. As a developer, I want the UI to be keyboard friendly and accessible, so that it is comfortable to use all day.
66. As a developer, I want clear credit and licences for the projects Bridge builds on, so that it can be shared publicly.

## Implementation Decisions

- **Shape of the product.** A launcher skill (`/bridge`) plus a standalone local daemon with a web UI. One global daemon serves all projects. v1 works on one repo per session, but the data model keeps a workspace that can hold many repos, with each ticket belonging to exactly one repo.
- **Stack.** TypeScript on Node, React with Vite and Tailwind for the UI, SQLite for run and agent state, WebSocket for live updates. The UI is rebuilt from the Claude Design canvas (tokens, layout, avatar shapes and states) rather than copied.
- **Core modules (deep, small interfaces).** A project/workspace registry; a ticket store that reads and writes the repo's ticket files; an agent runner that starts, stops and observes agents through an adapter; a sandbox manager behind a port (Docker Sandboxes first, local-clone mode as fallback); a permission and approval broker; an inbox; a PR tracker over the GitHub CLI; a skill-pipeline orchestrator for the lead; an agent tool server (MCP) exposing get-my-ticket, set-status, ask-user and request-access; and the UI.
- **Agent runtime.** The interactive Claude Code CLI inside a pseudo-terminal, using the user's subscription login, never API keys. Hooks written into each agent's workspace report status back to the daemon. The UI shows the terminal with a terminal emulator. Agents stop when the daemon stops; the daemon warns before quitting and resumes unfinished tickets on next launch.
- **Lead pipeline.** The lead runs grill-with-docs, to-spec and to-tickets with the user, pausing at gates. Workers run implement and tdd per ticket, diagnosing-bugs on failure, and pr for the PR text. code-review checks standards and spec. retro runs after a feature. wayfinder is available for very large work and triage for incoming issues. The skills are used as installed; the Bridge does not reimplement them.
- **Concurrency.** The lead proposes a worker count. Default cap 2, raisable to 3 in settings. Excess tickets queue. A detected rate limit pauses the queue.
- **Tickets and specs.** Local Markdown files in the repo following the tracker conventions already configured (one file per ticket, status line, blocked-by line). Bridge reads and writes status in those files; there is no separate ticket database.
- **Sandbox and secrets.** One sandbox per worker, holding a fresh clone, never the user's working copy. Real environment files are never mounted; the sandbox receives generated throwaway values and an optional per-ticket local database. Secrets live in the sandbox tool's secret store and are injected by proxy, never present inside the sandbox.
- **Permission model.** Inside the sandbox everything is allowed. Needing approval in the Inbox: new network domains, any secret, pushing to a remote, any real-database access. Never allowed: merging. Approvals can be Once, per Ticket or per Project, and can be undone. Network rules added by Bridge are tracked so only Bridge's own rules are removed.
- **Git flow.** One ticket, one clone, one branch, one pull request with the ticket ID in its title. The user merges. Requires a GitHub remote and a logged-in GitHub CLI; local-only repos merge branches locally on approval. New repos are created on GitHub after the user approves.
- **Analyst.** A distinct agent type, disabled by default, enabled per connection and per project. Uses a read-only database role for MongoDB or Postgres/Supabase, with credentials held on the host and queried through a host-side tool. Results return as analysis, with names and identifiers masked by default and a per-dataset approval.
- **Avatars and orbs.** Eight avatar shapes (circle, egg, squircle, pill, rounded triangle, rounded hexagon, cloud, teardrop), each with two slanted tick eyes, in an agent-specific colour chosen by the lead. The lead is larger with a ring. Nine states drive the animation. A small canvas thinking-orb (a vendored, tinted fork of the MIT-licensed `thinking-orbs`) shows activity in the agent's colour. State-to-orb mapping: planning to shaping, exploring to searching, implementing to working, debugging to solving, writing a PR to composing, waiting to listening.
- **Screens.** Board, Agents (with terminal drawer), Inbox, Plan, Review/PR, command palette, first-run setup, new-project dialog, permission-request component, Analyst card and empty states, as designed in the Claude Design canvas. Where the design disagrees with this spec (worker cap 5; Analyst shown with a granted production read), this spec wins.
- **Platform.** Windows 11 first. Docker Sandboxes availability on this machine is unverified and is the first thing to prove.
- **Credit.** JS Mastery's jsm-hq (MIT) is the reference for the sandbox and approval ideas; Pocock's skills and `thinking-orbs` (MIT) are credited with licences.

## Testing Decisions

- **One seam.** Tests drive Bridge through its **public API** (HTTP and WebSocket) against a temporary directory and temporary database. Agents are replaced by a **scripted fake agent adapter** that emits status, questions and access requests on cue, and the sandbox manager by an in-memory fake. This is the highest seam and covers nearly all behaviour.
- **What makes a good test.** It asserts external behaviour only: given a repo and a scripted agent, which tickets move, what appears in the Inbox, what gets approved or refused, what files change. It does not assert internal functions or call sequences.
- **Modules under test through the seam.** Registry, ticket store, runner, approval broker and inbox, PR tracker (with a fake GitHub CLI), pipeline orchestrator, cap and queue behaviour, restart and resume, the merge refusal, and the never-copy-env rule.
- **Beyond the seam.** A small number of real integration checks (real sandbox, real CLI login) are run manually or in a separate opt-in suite, not in the default test run. UI is checked with a few end-to-end browser tests against the fake adapter, plus visual comparison with the design.
- **Prior art.** None in this repo yet. The first ticket establishes the pattern for later tickets.

## Out of Scope

- Cross-repo planning (one feature spanning several repos): data model only in v1.
- A hosted or multi-user version; remote access beyond localhost.
- Codex or other model adapters.
- The pixel-art office, MCP-management UI, port-forwarding UI and per-site network UX from jsm-hq.
- Third-party review tools such as CodeRabbit.
- Running on macOS or Linux (not blocked, just untested).
- Automatic merging, ever.
- API-key billing mode.

## Further Notes

- Docker Desktop must be running and Docker Sandboxes installed before the sandbox work can be verified. Until then, build against the sandbox port with the fake and the local mode.
- Pro plan limits make parallelism costly; the cap and pause behaviour are features, not polish.
- Design source files are saved in the repo for reference; the design canvas link is the source of truth for visuals.
- Seams need the user's confirmation (one seam: the public API with fake agent and sandbox adapters).
