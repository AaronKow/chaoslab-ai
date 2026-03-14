# ChaosLab AI Orchestrator + MCP Preview

Step-by-step guide to:
1. set up a 3D model entity
2. assign character role/persona
3. connect via GitHub Copilot MCP
4. see it spawn/move/chat in preview world

## What This Repo Contains

- `services/orchestrator` - HTTP server (models, characters, sessions, commands, runtime world state).
- `services/orchestrator-mcp` - local MCP bridge server for Copilot.
- `services/mcp-agent` - optional autonomous worker (not required for Copilot MCP flow).
- `apps/mobile-expo` - mobile client scaffold for later iOS camera/AR integration.

## Prerequisites

- Node.js 18+
- pnpm
- VS Code with GitHub Copilot Chat + MCP enabled

## Quick Start (Full Flow)

### 1) Install dependencies

From repo root:

```bash
pnpm install
```

### 2) Start orchestrator

```bash
pnpm run dev:server
```

Open:
- [http://localhost:8787](http://localhost:8787)

### 3) Set up 3D model entity

Open:
- [http://localhost:8787/ui/models](http://localhost:8787/ui/models)

Do this in order:
1. Upload your model file (`.glb`, `.gltf`, `.usdz`, `.usdc`, `.obj`, `.fbx`)
2. In **Character Builder**, choose that model
3. Fill:
   - `Character ID`
   - `Actor ID` (used in command payloads)
   - `Name`
   - `Role`
   - `Voice Style`
   - `Bio / Guidance`
4. Click **Save Character**
5. In **Active Scene Context**, set:
   - `Active Model`
   - `Active Character`
6. Click **Save Active Scene**

This creates live context used by MCP at:
- `GET /api/mcp/context`

### 4) Configure Copilot MCP in VS Code

This workspace already includes:
- `.vscode/mcp.json`

Current config:

```json
{
  "servers": {
    "chaoslab-orchestrator": {
      "type": "stdio",
      "command": "node",
      "args": ["services/orchestrator-mcp/src/server.js"],
      "env": {
        "ORCHESTRATOR_URL": "http://localhost:8787"
      }
    }
  }
}
```

In VS Code:
1. Open this repo folder
2. Ensure Copilot MCP is enabled
3. Reload window if MCP server is not detected

### 5) Start preview world

Open:
- [http://localhost:8787/ui/runtime](http://localhost:8787/ui/runtime)

Click:
1. **Start Runtime Session**
2. **Spawn Active Character**

You now have a live session ID in runtime preview.

### 6) Drive it through Copilot MCP

In Copilot Chat, ask it to use MCP tools in this order:
1. `get_context`
2. `start_session` (or reuse runtime session)
3. `spawn_active`
4. repeated `send_command` with `move_to` and `say`
5. `get_world` to verify actor state/chat history

Available MCP tools:
- `get_context`
- `start_session`
- `spawn_active`
- `send_command`
- `get_world`
- `list_models`

## Recommended Copilot Prompt

Use this in Copilot Chat:

```text
Use the chaoslab-orchestrator MCP tools.
1) Get context.
2) Start a session.
3) Spawn active character.
4) Enter a loop: send move_to and say commands in character.
5) Check get_world after each cycle and adapt behavior.
```

## APIs (Core)

- `GET /api/models` - models + characters + active scene
- `POST /api/models/upload` - upload model binary
- `POST /api/models/:modelName/characters` - add/update character
- `PUT /api/scene` - set active model/character
- `GET /api/mcp/context` - role context for AI
- `POST /session/start` - create session
- `POST /control/:sessionId` - send command (`spawn`, `move_to`, `say`)
- `POST /api/scene/spawn/:sessionId` - spawn active scene character
- `GET /api/world?sessionId=...` - runtime world state

## Optional: Autonomous Local Agent (No Copilot)

If you want local auto-behavior without Copilot:

```bash
pnpm run dev:agent
```

Useful env vars:
- `ORCHESTRATOR_URL`
- `SESSION_ID`
- `TICK_MS`
- `CHAT_EVERY_N_TICKS`
- `AUTO_SPAWN`
- `MOVE_RADIUS`

## Troubleshooting

- `EADDRINUSE: 8787`:
  - another server is already running on port `8787`; stop it and retry.
- MCP tools not visible in Copilot:
  - confirm `.vscode/mcp.json` exists
  - reload VS Code window
  - keep `pnpm run dev:server` running
- `No active model/character selected`:
  - set and save active scene in `/ui/models` first.
- Runtime page is empty:
  - click **Start Runtime Session** and **Spawn Active Character**.
