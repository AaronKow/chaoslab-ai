# Quick Command Reference

Copy-paste these commands to get running quickly.

## Start Everything (4 terminals)

### Terminal 1: Orchestrator Server

```bash
pnpm install
pnpm run dev:server
```

Wait for:
```
✓ Server listening on port 8787
✓ Health check: http://localhost:8787/health
```

Open [http://localhost:8787](http://localhost:8787).

---

### Terminal 2: Web Runtime Preview (Optional)

Just open browser to [http://localhost:8787/ui/runtime](http://localhost:8787/ui/runtime).

No extra command needed — already running from Terminal 1.

---

### Terminal 3: Autonomous Agent (Optional)

```bash
pnpm run dev:agent
```

Or with custom settings:

```bash
MOVE_RADIUS=6 \
CHAT_EVERY_N_TICKS=4 \
TICK_MS=2500 \
AUTO_SPAWN=true \
  pnpm run dev:agent
```

---

### Terminal 4: Mobile App (Development)

```bash
cd apps/mobile-expo
pnpm start
```

Scan QR code from terminal with **Expo Go** app on iPhone/Android.

---

## Setup Your First Character (One-Time)

1. Go to [http://localhost:8787/ui/models](http://localhost:8787/ui/models)
2. **Upload a GLB file** (pick any `.glb` or `.gltf`)
3. **Character Builder tab**:
   - Model: (select the one you uploaded)
   - Character ID: `my-character`
   - Actor ID: `my-character`
   - Name: `My Character`
   - Role: `Fighter`
   - Voice Style: `Brave`
   - Bio: `Ready to fight.`
   - Click **Save Character**
4. **Active Scene Context tab**:
   - Active Model: (select your model)
   - Active Character: `my-character`
   - Click **Save Active Scene**

✅ Done! Your character is ready to use.

---

## Connect Mobile iPhone

```bash
# Terminal 4
cd apps/mobile-expo
pnpm start
```

On iPhone:
1. Open **Expo Go** app
2. Scan QR code
3. Enter server: `http://YOUR_LOCAL_IP:8787`
   - Find your IP: `ifconfig | grep "inet " | grep -v 127`
4. Tap **Connect to World** → **Spawn**

---

## Run a Fight via Copilot MCP

In VS Code Copilot Chat (**⌘ + ⇧ + I**):

```
Use the chaoslab-orchestrator MCP tools.
1. Get context.
2. Get shared session.
3. Spawn the active character.
4. Get world — find an opponent.
5. If opponent exists, move toward them and attack repeatedly until they're defeated.
6. Say "Victory!" when done.
```

---

## Full Fight Scenario (3 Views)

See [docs/FIGHT_SCENARIO.md](docs/FIGHT_SCENARIO.md) for step-by-step walkthrough.

Quick version:

```bash
# Terminal 1
pnpm run dev:server

# Terminal 2
pnpm run dev:agent

# Terminal 3
cd apps/mobile-expo && pnpm start

# Terminal 4
# Open http://localhost:8787/ui/runtime in browser

# Terminal 5
# Open VS Code Copilot and paste the fight prompt
```

---

## Common Useful Commands

### Kill Port 8787 (if stuck)

```bash
lsof -ti:8787 | xargs kill
```

### Reset Everything

```bash
# Kill all node processes
pkill -f "node "

# Reinstall deps
pnpm install

# Start fresh
pnpm run dev:server
```

### View Server Logs

```bash
# Already running in Terminal 1, but to tail separately:
# (Terminal 1 captures everything)
```

### Test Orchestrator Health

```bash
curl http://localhost:8787/health
```

Response:
```json
{
  "ok": true,
  "sessions": 1,
  "sharedSessionId": "shared-main"
}
```

### Fetch Current World State

```bash
curl "http://localhost:8787/api/world?sessionId=shared-main"
```

### List All Characters

```bash
curl http://localhost:8787/api/models
```

---

## File Structure (What You Need to Know)

```
chaoslab-ai/
├── README.md                      ← Start here
├── docs/
│   ├── FIGHT_SCENARIO.md         ← Full fight walkthrough
│   ├── http-api.md               ← API details
│   └── COMMANDS.md               ← This file
├── .github/
│   └── copilot-instructions.md   ← MCP tool reference
├── services/
│   ├── orchestrator/             ← Main server (edit here for world logic)
│   │   └── src/server.js         ← Everything: 2500 lines
│   ├── orchestrator-mcp/         ← Copilot bridge
│   │   └── src/server.js         ← MCP tool handlers
│   └── mcp-agent/                ← Autonomous agent
│       └── src/agent.js          ← Polling loop
├── apps/
│   └── mobile-expo/              ← iOS/Android app
│       ├── App.tsx               ← Three.js 3D + React Native UI
│       ├── app.json              ← Expo config
│       └── package.json          ← Latest dependencies
└── assets/
    └── models/                   ← Your uploaded GLB files
        ├── characters.json       ← Character registry (auto-generated)
        └── scene-state.json      ← Active model/character (auto-set)
```

---

## Updating Dependencies

Mobile app uses latest stable:

```bash
cd apps/mobile-expo
pnpm update
```

Pinned versions:
- Expo: 55.0.7
- React Native: 0.84.1
- React: 19.2.4
- Three.js: 0.183.2

---

## More Documentation

- **Main README**: [README.md](README.md) — Overview, features, all platforms
- **Mobile Dev Guide**: [apps/mobile-expo/README.md](apps/mobile-expo/README.md) — Three.js setup, debugging
- **Fight Walkthrough**: [docs/FIGHT_SCENARIO.md](docs/FIGHT_SCENARIO.md) — Step-by-step Copilot fight
- **MCP Tools**: [.github/copilot-instructions.md](.github/copilot-instructions.md) — Tool reference
- **HTTP API**: [docs/http-api.md](docs/http-api.md) — Endpoint details
