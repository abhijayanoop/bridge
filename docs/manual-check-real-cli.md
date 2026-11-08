# Manual check: real Claude CLI in the terminal drawer (Windows 11)

Not part of `npm test`. Run once by hand; it uses your own Claude login and edits the repo you point it at, so use a throwaway repo.

1. Make sure `claude` runs in a normal terminal and you are logged in (`claude` then `/status`).
2. `npm run build`, then `npm start`. Bridge uses the pty runner by default (`BRIDGE_FAKE_AGENT=1` switches to the scripted fake).
3. Open http://127.0.0.1:4317, open a throwaway repo with a `.scratch/<feature>/issues/NN-*.md` ticket, go to Agents, choose the ticket, Start agent.
4. Expect: the drawer shows Claude's TUI; its first prompt is the ticket task; a permission prompt shows in the terminal and typing `1`/Enter (or the input box) answers it; Stop ends the process and the status becomes `done`.
5. No `--dangerously-skip-permissions` is passed; sandboxing comes in later tickets.

If `claude` is not found: the runner resolves it on PATH (including `.cmd` shims). Check `where claude` in the same shell that started Bridge.

# Manual check: real code review (ticket 12)

Not part of `npm test`. The default suite uses a fake reviewer; this checks the real adapter (`createClaudeReviewer` in `src/server/reviewer.ts`) on your machine. It runs `claude -p` headless on the host with your login, in a fresh temporary checkout of the branch (not the agent's clone, whose git config and settings the agent controls), reading only your user-level Claude settings, with the file-changing tools denied.

1. Install the Pocock skills so `/mattpocock-skills:code-review` exists (Bridge also copies them into each clone).
2. Run an agent on a small throwaway ticket to done (see the check above). Expect, in its terminal: nothing opens straight away; the Review screen shows a card "Reviewing…".
3. When it finishes, expect the card to show Standards and Spec columns by severity. Clean: a pull request opens (or the local branch item, for a repo with no GitHub remote). Blocking findings: the agent's terminal gets a line starting "Code review of your branch found work to do" and its status goes back to working.
4. If the card says "Review could not run", read the reason. A reply that was not the expected JSON is the usual cause: run `claude -p "<prompt>"` by hand in the clone (the prompt is `reviewPrompt` in `src/server/reviewer.ts`) and adjust the prompt or the tool list.
5. The review is allowed Read, Grep, Glob, Agent and a few read-only `git` commands only; if the skill needs more, it will stop at a permission prompt that `-p` cannot answer and the review will fail rather than change anything.
