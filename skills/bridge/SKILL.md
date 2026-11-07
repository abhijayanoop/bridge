---
name: bridge
description: Start the Bridge local control room (or reuse the running one) and open it in the browser. Use when the user types /bridge or asks to open Bridge.
---

# Bridge launcher

1. Run `node bin/bridge.mjs` from the Bridge repo (or `bridge` if linked). It starts the daemon on port 4317 unless one already answers at `/api/health`, then opens the browser.
2. Set `BRIDGE_PORT` to use another port. Pass `--no-open` to skip the browser.
3. Tell the user the URL printed by the command. Do not start a second daemon.
