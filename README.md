# ChaosLab AI — Real-time 3D World Orchestration

A multiplayer 3D world server with AI-driven characters, combat simulation, and live multi-client synchronization. Control characters via **GitHub Copilot MCP**, **web browser**, **iOS/Android mobile app**, or **autonomous local agent**.

## What This Repo Contains

| Service | Path | Purpose |
|---|---|---|
| **Orchestrator** | `services/orchestrator` | Central HTTP server (8787) — sessions, world state, 3D models, commands, web UI |
| **Orchestrator MCP** | `services/orchestrator-mcp` | stdio MCP bridge for GitHub Copilot Chat |
| **MCP Agent** | `services/mcp-agent` | Optional autonomous character controller (no Copilot required) |
| **OpenAI Agent** | `services/openai-agent` | Optional Node.js autonomous controller powered by OpenAI model decisions |
| **Mobile Expo** | `apps/mobile-expo` | React Native + Three.js 3D world for iOS/Android |

## Prerequisites

- **Node.js** 20+ (LTS)
- **pnpm** 10+
- **VS Code** with **GitHub Copilot Chat + MCP** (for AI control)
- **Xcode** 15+ or **Android Studio** (for native iOS/Android build)
- **iPhone/Android device** or emulator

## 🚀 Quick Start — All Platforms

### Step 1: Install & Start Orchestrator

```bash
pnpm install
pnpm run dev:server
```

Open [http://localhost:8787](http://localhost:8787) — you'll see the landing page with links to all UIs.

### Step 2: Create a 3D Character

1. Visit [http://localhost:8787/ui/models](http://localhost:8787/ui/models)
2. **Upload Model**:
   - Choose a `.glb`, `.gltf`, `.usdz`, `.usdc`, `.obj`, or `.fbx` file
   - ✅ Confirm upload
3. **Character Builder**:
   - Select the uploaded model
   - Enter:
     - **Character ID**: `dora-explorer` (no spaces)
     - **Actor ID**: `dora-explorer` (same, used in commands)
     - **Name**: `Dora` (display name)
     - **Role**: `Explorer and guide`
     - **Voice Style**: `Energetic and helpful`
     - **Bio / Guidance**: `Stay in character. Help others explore.`
   - Click **Save Character**
4. **Active Scene Context**:
   - Select the model in **Active Model**
   - Select the character in **Active Character**
   - Click **Save Active Scene**

✅ Your world is now ready for three types of clients: mobile, web, and AI.

---

## 🤖 OpenAI Node.js Agent (Model-Controlled Fighter)

Run an autonomous fighter that reads world state, asks an OpenAI model what to do, and executes `move_to`, `attack`, and `say` commands with server-safe payloads.

```bash
# Terminal 2
OPENAI_API_KEY=sk-... \
OPENAI_MODEL=gpt-4.1-mini \
pnpm run dev:openai-agent
```

Optional environment variables:
- `CHARACTER_ID` — force a specific character id to control/spawn
- `TICK_MS` — decision interval (default `1800`)
- `AUTO_SPAWN` — auto-spawn controlled actor if missing (`true` by default)
- `ALLOW_SAY` — allow in-character chat output (`true` by default)
- `SAY_EVERY_N_TICKS` — chat cadence (default `4`)

---

## 📱 Connect Your iOS Phone

### Via Expo Go (Fastest)

1. **On your machine**, start the development server:
   ```bash
   cd apps/mobile-expo
   pnpm start
   ```

2. **On your iPhone**:
   - Install **Expo Go** from App Store
   - Open Expo Go
   - Scan the QR code from your terminal

3. **In the app**:
   - **Server URL**: `http://<your-machine-ip>:8787`
     - Find your IP: `ifconfig | grep "inet " | grep -v 127`
     - Example: `http://192.168.1.50:8787`
   - Tap **Connect to World**
   - Tap **Spawn** (spawns active character)
   - **Drag** to orbit camera, **pinch** to zoom

✅ You're now seeing the 3D world in real-time on your phone.

---

### Via Native iOS Build (Production)

```bash
cd apps/mobile-expo
pnpm run ios
```

This builds and installs the native Expo app on your phone (requires Xcode).

---

## 🤖 Connect AI (GitHub Copilot MCP)

### Setup

1. **Ensure orchestrator is running**:
   ```bash
   pnpm run dev:server
   ```

2. **In VS Code**, open Copilot Chat (⌘ + ⇧ + I)

3. **Paste this prompt**:
   ```
   You are commanding a 3D character in the ChaosLab world using MCP tools.
   1. Call get_context to load the scene and active character.
   2. Call get_shared_session to get the world session ID.
   3. Call spawn_avatar with character="dora-explorer" to place the character.
   4. Loop:
      - Call get_world to see current actors and opponents.
      - Pick an opponent (another actor).
      - Move toward them: send_command(type="move_to", payload={actorId: "...", position: [x, y, z]})
      - When in range (< 2.2 units): send_command(type="attack", payload={actorId: "..."})
      - Every 3 turns, chat in character: send_command(type="say", payload={actorId: "...", text: "[action:defend] Bring it on!"})
      - If no opponent, find a spawn point and move there.
   ```

✅ Copilot will use MCP tools to control the character in real-time.

**Available MCP Tools**:
- `get_context` — fetch active character + scene
- `get_shared_session` — get the world session ID
- `list_models` — list all uploaded models + characters
- `spawn_avatar` — spawn a character by name (e.g., `"dora-explorer"`)
- `send_command` — send action (spawn, move_to, say, play_animation, attack)
- `get_world` — check actors, chats, combat events

---

## ⚔️ Full Fight Scenario Walkthrough

### Setup (Run These Once)

```bash
# Terminal 1: Start the orchestrator
pnpm run dev:server

# Terminal 2: (Optional) Start an autonomous opponent
MOVE_RADIUS=5 CHAT_EVERY_N_TICKS=5 pnpm run dev:agent
```

Open [http://localhost:8787/ui/runtime](http://localhost:8787/ui/runtime) to watch the fight in the web browser.

### Scenario: Two-Character Fight

**Goal**: Copilot-controlled `dora-explorer` fights the autonomous agent (another instance of the same character).

#### Phase 1: Spawn Both Characters

**In Copilot Chat**, paste:
```
Use MCP tools to:
1. Get context and shared session.
2. Spawn dora-explorer at position [3, 0, 0].
3. Verify it appears in get_world by checking actors[].actorId == "dora-explorer".
4. Report back what you see.
```

**In Terminal 2**, the agent spawns a second dora at a randomized position (within ±6 units). 

**On web** ([http://localhost:8787/ui/runtime](http://localhost:8787/ui/runtime)): You now see 2 actors with glow rings and movement trails.

---

#### Phase 2: AI Pursues & Attacks

**In Copilot Chat**, paste:
```
Use MCP tools in a loop (max 15 iterations):
1. get_world → find the first actor where actorId != "dora-explorer" (that's your opponent).
2. Calculate distance to opponent.
3. If distance > 2.2 units:
   - move_to opponent's position
   - message: "Pursuing!"
4. If distance <= 2.2 units:
   - attack the opponent
   - message showing damage dealt
5. Every 3 iterations, say something in character: "[action:defend] En garde!"
6. Wait 1 second between iterations.
7. Stop if opponent health <= 0.
```

**What happens**:
- **On web**: Dora slides toward opponent, plays walk/run animation, turns to face them
- **On iOS**: Same 3D sync, camera orbits smoothly, health bars appear
- **In chat log**: Combat events logged (attack_hit, collision_damage, eliminated)

---

#### Phase 3: Defeat & Victory

When opponent health hits 0:
- Actor is removed from world
- Combat event logged: `{type: "eliminated", loser: "...", winner: "dora-explorer"}`
- Dora idles (plays idle loop animation)

**In Copilot Chat**, ask:
```
The opponent has been eliminated! Report victory and reset the world.
```

Copilot will call `send_command(type="say", ...)` with a victory message, then the loop ends.

---

## 🎮 Web Preview (No Mobile Required)

Open [http://localhost:8787/ui/runtime](http://localhost:8787/ui/runtime) to watch in real-time:
- **Click Spawn Active Character** to spawn the active character
- **Auto Move + Chat** button demo: random movement + auto-chat every 3 seconds
- **Live 3D world**: ground, grid, glow rings, movement trails, health HUD, damage popups

Use **mouse**:
- **Drag** to orbit camera
- **Scroll** to zoom

---

## 🏗️ Development

### Orchestrator Server

All business logic lives here. Edit `services/orchestrator/src/server.js`:

```bash
pnpm run dev:server
```

Hot-reload on save. The server is ~2500 lines:
- World simulation (movement, collision, attack range, animation triggers)
- Session management (30-min TTL per session)
- Command queue (MCP, mobile, agent feed commands here)
- HTTP API + web UI HTML (embedded)

### Mobile App (Expo)

Full 3D world in React Native + Three.js. Edit `apps/mobile-expo/App.tsx`:

```bash
cd apps/mobile-expo
pnpm install
pnpm start
```

Latest tech stack:
- **Expo SDK 55** (Expo 55.0.7)
- **React Native 0.84.1** (latest stable)
- **Three.js 0.183.2** (fully featured renderer)
- **React 19.2.4**

See [apps/mobile-expo/README.md](apps/mobile-expo/README.md) for detailed mobile dev guide.

### MCP Agent (AI Loop)

Autonomous character that polls and sends random commands. Edit `services/mcp-agent/src/agent.js`:

```bash
pnpm run dev:agent
```

Env vars:
- `ORCHESTRATOR_URL` (default: `http://localhost:8787`)
- `TICK_MS` (default: `3000`) — poll/tick interval
- `MOVE_RADIUS` (default: `4`) — how far to move randomly
- `AUTO_SPAWN` (default: `true`) — auto-spawn if no actor found

---

---

## 🛠️ Core HTTP API

| Endpoint | Method | Purpose |
|---|---|---|
| `/session/shared` | GET | Get/create shared world session |
| `/api/models` | GET | List all models + characters + active scene |
| `/api/models/:name/characters` | POST | Add/update character definition |
| `/api/scene` | PUT | Update active model + character |
| `/api/mcp/context` | GET | Get active character role + command schema |
| `/api/world` | GET | Get current world state (actors, chats, combat) |
| `/api/scene/spawn` | POST | Spawn active character to shared session |
| `/control` | POST | Send command (move_to, say, attack, etc.) |
| `/commands` | GET | Long-poll for commands (mobile long-polling) |
| `/ack` | POST | Acknowledge command by ID |

**Example command**:
```bash
curl -X POST http://localhost:8787/control \
  -H "Content-Type: application/json" \
  -d '{
    "type": "move_to",
    "payload": {
      "actorId": "dora-explorer",
      "position": [5, 0, 3]
    }
  }'
```

---

## 🚨 Troubleshooting

| Issue | Solution |
|---|---|
| Port **8787** in use | `lsof -ti:8787 \| xargs kill` |
| MCP tools not visible in Copilot | Reload VS Code; ensure `pnpm run dev:server` is active |
| Mobile app won't connect | Use your machine's LAN IP (not localhost); find via `ifconfig \| grep "inet "` |
| No actor appears on spawn | Check `/ui/models` — active model + character must be set |
| iOS build fails | Update Xcode; run `npx expo prebuild --clean` |

---

## 📖 Further Reading

- [.github/copilot-instructions.md](.github/copilot-instructions.md) — MCP tool reference + conventions
- [apps/mobile-expo/README.md](apps/mobile-expo/README.md) — Mobile app architecture + Three.js setup
- [docs/http-api.md](docs/http-api.md) — Detailed HTTP API reference
