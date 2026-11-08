# Manual check: real Claude CLI in the terminal drawer (Windows 11)

Not part of `npm test`. Run once by hand; it uses your own Claude login and edits the repo you point it at, so use a throwaway repo.

1. Make sure `claude` runs in a normal terminal and you are logged in (`claude` then `/status`).
2. `npm run build`, then `npm start`. Bridge uses the pty runner by default (`BRIDGE_FAKE_AGENT=1` switches to the scripted fake).
3. Open http://127.0.0.1:4317, open a throwaway repo with a `.scratch/<feature>/issues/NN-*.md` ticket, go to Agents, choose the ticket, Start agent.
4. Expect: the drawer shows Claude's TUI; its first prompt is the ticket task; a permission prompt shows in the terminal and typing `1`/Enter (or the input box) answers it; Stop ends the process and the status becomes `done`.
5. No `--dangerously-skip-permissions` is passed; sandboxing comes in later tickets.

If `claude` is not found: the runner resolves it on PATH (including `.cmd` shims). Check `where claude` in the same shell that started Bridge.
