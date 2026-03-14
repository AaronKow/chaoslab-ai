# ChaosLab AI AR Pilot

iOS-first AR pilot scaffold with:
- an HTTP orchestrator server
- an Expo mobile client
- an MCP-friendly control endpoint for injecting commands

## Project structure

- `services/orchestrator` - Express server for sessions, events, command polling, and command injection.
- `apps/mobile-expo` - Expo app that starts a session, polls commands, and sends ACKs.
- `docs/http-api.md` - MVP API contract.

## Prerequisites

- Node.js 18+
- npm 9+
- Xcode + iOS Simulator (for local iOS testing)
- Optional: Expo Go on iPhone (same Wi-Fi as your dev machine)

## 1) Start the orchestrator server

From repo root:

```bash
npm install
npm run dev:server
```

Expected output:

```text
Orchestrator server running on http://localhost:8787
```

Quick health check in another terminal:

```bash
curl http://localhost:8787/health
```

You should see JSON like:

```json
{"ok":true,"sessions":0}
```

## 2) Start the Expo app

In a new terminal (from repo root):

```bash
npm run dev:mobile
```

Then:
- press `i` to launch iOS Simulator, or
- scan the QR code with Expo Go on your iPhone.

Inside the app:
1. In `Server URL`, set your orchestrator URL.
2. Tap `Start Session`.
3. Confirm a `Session ID` appears.

### Which Server URL should you use?

- iOS Simulator on same Mac: `http://localhost:8787`
- Physical iPhone: `http://<YOUR_MAC_LAN_IP>:8787` (example: `http://192.168.1.25:8787`)

If testing on phone, make sure:
- phone + Mac are on same network
- macOS firewall allows Node incoming connections

## 3) Connect using MCP (command injection flow)

The orchestrator already exposes an MCP-bridge-friendly endpoint:

- `POST /control/:sessionId`

### Manual smoke test (no bridge yet)

After the app session is started, copy the shown `Session ID` and run:

```bash
curl -X POST "http://localhost:8787/control/<SESSION_ID>" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "say",
    "payload": {
      "actorId": "npc-1",
      "text": "hello from control"
    }
  }'
```

The command should appear in the Expo app under `Latest Commands`.

### Hooking an MCP bridge

Your MCP bridge service should:
1. Receive tool output or agent decisions.
2. Map those into your command schema (`type` + `payload`).
3. POST commands to `/control/:sessionId`.

Minimal bridge target example:

```text
POST http://<orchestrator-host>:8787/control/<sessionId>
Content-Type: application/json
{
  "type": "move_to",
  "payload": {
    "actorId": "npc-1",
    "position": [0.2, 0.0, -1.2],
    "speed": 1.2
  }
}
```

For full request/response details, see [`docs/http-api.md`](docs/http-api.md).

## 4) Autonomous MCP Agent (Copilot bridge scaffold)

This repo now includes a minimal autonomous worker:

- `services/mcp-agent`

What it does:
1. starts (or reuses) a session
2. reads role context from `GET /api/mcp/context`
3. auto-spawns the active character (if needed)
4. continuously sends `move_to` + periodic `say` commands to `/control/:sessionId`

### Setup order

1. Start orchestrator:

```bash
pnpm run dev:server
```

2. Open model manager and set active character:

```text
http://localhost:8787/ui/models
```

3. (Optional) Open runtime preview:

```text
http://localhost:8787/ui/runtime
```

4. Start autonomous agent:

```bash
pnpm run dev:agent
```

### Useful env vars

- `ORCHESTRATOR_URL` (default: `http://localhost:8787`)
- `SESSION_ID` (reuse an existing session)
- `TICK_MS` (default: `3000`)
- `CHAT_EVERY_N_TICKS` (default: `3`)
- `AUTO_SPAWN` (`false` disables spawn helper)
- `MOVE_RADIUS` (default: `4`)

## Troubleshooting

- `npm install` fails:
  - check registry/network access
  - retry with `npm config get registry` and verify it points to npmjs
- Expo app cannot reach server from phone:
  - use Mac LAN IP instead of `localhost`
  - confirm server is running on port `8787`
- `Missing or invalid session` errors:
  - start session from app first and use the newest `Session ID`

## Next steps

1. Add a real MCP bridge worker (tool output -> safe command schema).
2. Add auth between mobile app, orchestrator, and bridge.
3. Add persistence (Redis/Postgres) for production-ready command history and session state.
