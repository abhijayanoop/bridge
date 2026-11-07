# Testing

Bridge has one test seam: the daemon's public API (HTTP and WebSocket). Tests never call internal functions.

## Pattern

1. Create a temporary directory and start the daemon with `startDaemon({ dataDir, runner })`. Port defaults to a free one; the result has `url` and `close()`.
2. Pass a scripted adapter, for example `createFakeAgentRunner([...events])` from `src/server/fake-agent.ts`. It emits status, question and access-request events on cue. Later fakes (sandbox, GitHub CLI) are injected the same way.
3. Drive the daemon with `fetch` and a `WebSocket` client. Assert only external behaviour: responses, streamed events, persisted state after a restart on the same directory.
4. Register cleanup (`close()`, remove the temp directory) in `afterEach`. Wait for async events with `expect.poll`, never fixed sleeps.

See `tests/walking-skeleton.test.ts` for the reference example.

## Running

- `npm test` runs the default suite (fast, no network, no Docker, no real agent).
- `npm run typecheck` checks types. `npm run build` builds the UI.
- Real integrations (sandbox, Claude login) belong in a separate opt-in suite, not the default run.
