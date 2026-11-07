# Bridge

A local control room for a lead engineer agent and sandboxed worker agents. See `.scratch/bridge/spec.md` for the plan.

Status: walking skeleton (daemon, API, dark UI shell, fake agent).

## Run

Requires Node 24 or newer.

```
npm install
npm run build
node bin/bridge.mjs      # starts or reuses the daemon on port 4317 and opens the browser
```

The `/bridge` skill lives in `skills/bridge/SKILL.md`. Tests: `npm test` (see `docs/testing.md`).

## Credits

Design ideas from JS Mastery's jsm-hq (MIT) and Matt Pocock's skills; `thinking-orbs` (MIT) is planned for later tickets.
