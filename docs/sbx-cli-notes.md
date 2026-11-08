# sbx (Docker Sandboxes) CLI notes for ticket 09

Verified on this machine (Windows 11) with `sbx v0.51.0`, 2026-11-08. Use these, not guessed syntax.

## Location and PATH
- `sbx.exe` is at `%LOCALAPPDATA%\DockerSandboxes\bin` (per-user winget install). Sessions started before the install do not have it on `PATH`. The adapter should detect `sbx` on `PATH`, then fall back to that directory, before reporting "missing".
- Docker Desktop is not required by `sbx` (standalone, own microVM backend). `sbx login` (Docker OAuth) has already been done.

## Commands (always pass the global flag `--no-input`: never prompt, fail with the command to run)
- Detect: `sbx version`
- Create: `sbx --no-input create --name <name> claude <path>`
  - `--clone`: agent works on a private in-container clone of the host repo (mounted read-only); its commits appear on the host as git remote `sandbox-<name>`.
  - `--deny-network <host>`: per-sandbox deny rule at creation. `-e KEY=VAL` / `--env-file` set env vars. `--cpus`, `--memory` size it.
  - Name: letters, numbers, hyphens, periods; at least 2 chars; starts with letter/number; `default` reserved.
- Run agent non-interactively: `sbx --no-input exec <name> claude -p "<prompt>"` (verified: works, exit 0). Interactive: `sbx exec -it <name> <cmd>`.
  - `exec` exit status is the command's. `125` = sbx could not run it (e.g. no such sandbox). `127` = command not found. A stopped sandbox is started first.
  - Also: `sbx run [--name n] claude [path] [-- agent args]` (interactive session; `-d` prints the id without attaching; `--rm` removes after exit).
- List: `sbx ls` ("No sandboxes found" when empty). Stop: `sbx stop <name>`. Remove: `sbx --no-input rm --force <name>` (`--force` skips the confirmation prompt).
- Network policy (global by default, `--sandbox <name>` scopes to one sandbox):
  - Allow: `sbx policy allow network [--sandbox <name>] <host[,host...]>` (supports `example.com`, `*.example.com`, `**.example.com`, `host:port`, CIDR; TCP by default, `--protocol tcp,udp`; HTTP rules via `--method/--path/--query`).
  - Deny: `sbx policy deny network ...`. Deny beats allow across scopes.
  - A rule is refused (nothing added) if the same scope holds the opposite decision for the same resource. Remove first: `sbx policy rm network --id RULE_ID [--sandbox <name>]`.
  - Inspect: `sbx policy ls [<name>]`, `sbx policy log`, `sbx policy check`.
  - Default on this machine: `default-deny-all` plus a `local-policy` already allowing ~195 hosts.
- Secrets: `sbx secret ls|set|rm|import`. A proxy injects stored secrets into API requests; the agent never sees them. `sbx secret set` has a global scope (shared) or per-sandbox scope.

## Subscription login (the ticket's manual check)
- `sbx secret ls` shows `(global) service anthropic (oauth configured)` after a one-time `/login` inside a sandboxed Claude.
- A brand-new sandbox then ran `claude -p "say hi in 3 words"` with no login and answered ("Hi there, friend!", exit 0). So the subscription login persists across sandboxes via the host-side secret. The login screen inside a fresh sandbox is not a reliable signal; test with `claude -p`.
- Do not set `ANTHROPIC_API_KEY`.

## Things not to rely on
- Experimental commands: `env`, `kit`, `setup`, `skills`. Cloud (`--cloud`) is out of scope.
- `sbx policy set-default` does not exist (guides were wrong). Use `sbx policy init`.
