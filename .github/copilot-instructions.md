# ChaosLab AI — Copilot Instructions

## Project Overview

**ChaosLab AI** is a real-time 3D world orchestration system. A Node.js/Express HTTP server manages in-memory sessions, actor world state, and a command queue. AI agents (Copilot via MCP, or an autonomous local agent) drive 3D character behavior by sending typed commands; a Three.js web UI and a React Native mobile app consume the state.

### Service Map

| Service | Path | Port | Purpose |
|---|---|---|---|
| Orchestrator | `services/orchestrator` | **8787** | Central server — sessions, world state, HTTP API, web UI |
| Orchestrator MCP | `services/orchestrator-mcp` | stdio | MCP bridge for VS Code Copilot |
| MCP Agent | `services/mcp-agent` | — | Optional autonomous polling agent (no Copilot required) |
| Mobile Expo | `apps/mobile-expo` | — | React Native scaffold for command polling |

---

## Build & Dev Commands

```bash
# Install all workspace dependencies
pnpm install

# Start the main orchestrator (required for everything else)
pnpm run dev:server       # → node services/orchestrator/src/server.js on :8787

# Start the autonomous agent (optional, no Copilot)
pnpm run dev:agent        # → node services/mcp-agent/src/agent.js

# Start the mobile Expo app
pnpm run dev:mobile       # → expo start

# Start MCP bridge standalone (Copilot launches this automatically)
pnpm run dev:mcp          # → node services/orchestrator-mcp/src/server.js
```

> `pnpm run dev:server` must be running before using any MCP tools or the mobile app.

---

## Architecture & Key Conventions

### All state is in-memory in the orchestrator

There is no database. The orchestrator holds:
- `sessions` — UUID → session metadata (30-minute TTL)
- `commandQueues` — UUID → ordered command list
- `worldStates` — UUID → actors Map, chats, arrivals, combatEvents

Persistence is limited to two JSON files on disk:
- `assets/models/characters.json` — character registry, keyed by model filename
- `assets/models/scene-state.json` — active model + character selection

### Shared session is the default

The string `"shared-main"` is the canonical shared session. The aliases `"shared-session"` and `"shared"` also resolve to it. When writing MCP flows or agent code, prefer `get_shared_session` rather than `start_session` to avoid per-agent session drift.

### Command queue pattern (long-polling)

Clients (mobile app, 3D runtime) long-poll `GET /commands?sessionId=...&since=<cursor>&timeout=5000`. After receiving commands they `POST /ack` each commandId. The cursor advances client-side.

### Backend owns locomotion

When sending a `move_to` command, **do not include `speed` or `locomotionMode`** — the server strips them and picks autonomously (70% walk @ 1.0–1.4, 30% sprint @ 1.8+). Setting these fields has no effect.

### Actor ID must be explicit for action commands

`move_to`, `say`, `attack`, and `play_animation` all require `actorId` in the payload. Obtain it from `GET /api/world` → `actors[].actorId` before sending action commands. The MCP `send_command` tool will throw if `actorId` is missing.

### Character resolution in MCP

`spawn_avatar` resolves characters via fuzzy match (exact ID/name first, then substring). Queries are lowercased. Always prefer passing the exact `characterId` to avoid ambiguity.

### `[action:clipname]` tag in say commands

Including `[action:clipname]` in a `say` payload (e.g. `"[action:defend] I stand ready!"`) triggers the orchestrator-mcp to automatically fire a follow-up `play_animation` command for that clip. This is transparent to the caller.

---

## MCP Tools (Available in Copilot Chat)

The MCP bridge exposes these tools under the `chaoslab-orchestrator` server:

| Tool | What it does |
|---|---|
| `get_context` | Fetch scene + role prompt + command schema from `/api/mcp/context` |
| `get_shared_session` | Get the shared sessionId (always use before action tools) |
| `list_models` | Full character + model registry |
| `spawn_avatar` | Spawn a character into the world by name/ID |
| `send_command` | Send `spawn`, `move_to`, `say`, `play_animation`, or `attack` |
| `get_world` | Read current actors, chats, arrivals, combatEvents |

**Standard Copilot agent flow:**
1. `get_context` — load scene and role
2. `get_shared_session` — get sessionId
3. `spawn_avatar` or `send_command {type:"spawn"}` — place character
4. Loop: `get_world` → decide action → `send_command`

---

## World Simulation Constants

| Constant | Value | Meaning |
|---|---|---|
| `SPAWN_RANGE` | 6 units | Random radius for initial spawn position |
| `ACTOR_RADIUS_DEFAULT` | 0.55 | Collision sphere per actor |
| `COLLISION_DAMAGE` | 8 HP | Damage from physical collision |
| `COLLISION_COOLDOWN_MS` | 900 ms | Min time between collision damage events |
| `ATTACK_RANGE` | 2.2 units | Max distance for melee attacks |
| `ATTACK_DAMAGE` | 10–18 HP | Random damage per attack |
| `ATTACK_FACING_DOT` | 0.64 | Cosine threshold (~50° cone) for hit validation |
| Chat cap | 50 entries | `world.chats[]` maximum length |
| Combat event cap | 120 entries | `world.combatEvents[]` maximum length |
| Session TTL | 30 min | Inactivity before session + world state is purged |

---

## Key Files

| File | Purpose |
|---|---|
| `services/orchestrator/src/server.js` | Entire orchestrator — all routes, world simulation, UI HTML |
| `services/orchestrator-mcp/src/server.js` | MCP stdio bridge — tool definitions + orchestrator HTTP calls |
| `services/mcp-agent/src/agent.js` | Autonomous tick loop — random movement + say |
| `apps/mobile-expo/App.tsx` | React Native command-polling UI |
| `assets/models/characters.json` | Persistent character registry |
| `assets/models/scene-state.json` | Persistent active scene selection |
| `.vscode/mcp.json` | VS Code Copilot MCP server registration |
| `docs/http-api.md` | HTTP API quick-reference |

---

## Common Pitfalls

- **Port 8787 already in use**: Another orchestrator process is running. Kill it with `lsof -ti:8787 | xargs kill` before restarting.
- **MCP tools not visible in Copilot**: `.vscode/mcp.json` must exist and `pnpm run dev:server` must be running. Reload the VS Code window after starting the server.
- **"No active model/character selected"**: Open `http://localhost:8787/ui/models`, assign a model + character, and click **Save Active Scene** before using MCP tools.
- **Actor always seems to miss attacks**: Attacker must be facing within ~50° of target (`ATTACK_FACING_DOT` 0.64). Use `move_to` first to close distance and orient, then `attack`.
- **`reuseActorId` flag**: Pass `reuseActorId: true` in a spawn payload to restore a specific actor at a new position without creating a duplicate.
- **Model upload**: Only `.glb`, `.gltf`, `.usdz`, `.usdc`, `.obj`, `.fbx` are accepted. Other formats return a 400 error.
- **Session drift with autonomous agent**: If `pnpm run dev:agent` is running alongside Copilot MCP, both share `"shared-main"`. World events from the agent will appear in `get_world` responses.

---

## Web UIs (Orchestrator)

| URL | Purpose |
|---|---|
| `http://localhost:8787` | Landing page + API links |
| `http://localhost:8787/ui/models` | Upload models, build characters, set active scene |
| `http://localhost:8787/ui/runtime` | Three.js 3D preview — spawn, animate, watch combat |
| `http://localhost:8787/health` | Health check + session count |
