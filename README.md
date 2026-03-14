# ChaosLab AI AR Pilot

Starter monorepo for an iOS-first AR experience with HTTP orchestration.

## What is included

- `services/orchestrator`: Node/Express HTTP server that manages device sessions and command queues.
- `apps/mobile-expo`: Expo app scaffold that starts a session and polls for commands over HTTP.
- `docs/http-api.md`: API contract for client/server/backend-bridge integration.

## Why HTTP-first

This MVP avoids WebSockets and uses long-polling (`GET /commands`) so deployment is simpler on standard hosting.

## Quick start

```bash
npm install
npm run dev:server
```

In another terminal:

```bash
npm run dev:mobile
```

Set the app server URL to your orchestrator endpoint (or local LAN IP + `:8787`).

## Next implementation steps

1. Add AR rendering in the Expo app (plane detection, anchor, character rig).
2. Add MCP bridge service that converts Codex/GitHub outputs into safe command schema.
3. Add auth (JWT/session token) and persistence (Redis/Postgres).
