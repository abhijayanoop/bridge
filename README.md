# Bridge

A local control room for a lead engineer agent and sandboxed worker agents. You describe a feature; the lead grills you, writes a spec, slices it into tickets and proposes how many workers to use. Each worker builds one ticket in its own sandboxed clone on its own branch. You watch every agent, answer questions and approve access in one Inbox, and merge the pull requests yourself. It runs on your Claude Pro login, never an API key.

Dark UI, one coloured avatar per agent whose animation shows its state, and a small thinking-orb beside it.

## Demo

1. Run `bridge` in a repo. The browser opens on the **Board**.
2. Ask the lead for a feature on **Plan**. It pauses at the spec and ticket gates for your approval.
3. Approved tickets start as workers, up to the **worker cap** (default 2, raisable to 3). Extra tickets queue; a detected rate limit pauses the queue.
4. Workers ask questions and request access in the **Inbox**. Each request can be approved Once, per Ticket or per Project, and undone later.
5. Each ticket ends as a pull request on **Review**, checked against standards and spec. You merge it from Review; agents cannot.
6. Optionally switch on the read-only **Analyst** per database connection to ask questions about real data, with names masked.

`Ctrl K` opens the command palette for quick actions.

## Run

Requires Node 24 or newer (Windows 11 first).

```
npm install
npm run build
node bin/bridge.mjs      # starts or reuses the daemon on port 4317 and opens the browser
```

The `/bridge` skill lives in `skills/bridge/SKILL.md`. Optional extras: Docker Sandboxes (`sbx`) for isolated workers, the GitHub CLI for pull requests.

## Develop

```
npm test           # default suite: no network, no Docker, no real agent
npm run typecheck
npm run build
```

See [docs/testing.md](docs/testing.md). Manual checks for the real CLI, sandbox and Analyst are in `docs/manual-check-*.md`.

## Docs

- [Architecture](docs/architecture.md)
- [Threat model](docs/threat-model.md)
- [Credits and licences](docs/credits.md)

## Credits

- jsm-hq by JS Mastery (MIT): reference for the sandbox and approval ideas.
- Matt Pocock's skills: used as installed to drive the lead pipeline and workers.
- [thinking-orbs](https://github.com/RareFormLabs/thinking-orbs) by Jakub Antalik (MIT): vendored, tinted fork in `third-party/thinking-orbs/`, licence retained.

Full notes in [docs/credits.md](docs/credits.md).
