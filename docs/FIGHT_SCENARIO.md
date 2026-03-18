# Fight Scenario Walkthrough

This guide walks you through a complete multiplayer fight scenario using the ChaosLab system. You'll control one character via Copilot MCP and watch an opponent controlled by the autonomous agent.

## Setup

### Terminal 1: Start the Orchestrator

```bash
pnpm run dev:server
```

Wait for:
```
✓ Server listening on port 8787
```

### Terminal 2: Start MCP Agent (Your Opponent)

```bash
MOVE_RADIUS=5 CHAT_EVERY_N_TICKS=5 AUTO_SPAWN=true pnpm run dev:agent
```

This autonomous agent will:
- Spawn a character every 3 seconds (if none exists)
- Move randomly within a 5-unit radius
- Chat every 5 ticks (~15 seconds)

### Open Web Preview (Watch in Real-Time)

Go to [http://localhost:8787/ui/runtime](http://localhost:8787/ui/runtime) in your browser.

Click:
1. **Start Runtime Session** (creates a new session ID)
2. **Spawn Active Character** (places your active model at a random spot)

You should now see **one actor** on the 3D world. The agent will spawn another actor shortly.

---

## Phase 1: Observe Both Fighters

**Goal**: Wait for both actors to spawn and see them on screen.

### What Happens Automatically

1. **~5 seconds**: Agent spawns a second character
2. **Web browser**: Two actors visible with glow rings
3. **Status**: Both idle (playing "idle loop" animation)

### What to Look For

- ✅ Two actors visible with different positions
- ✅ Both have glow rings (pulsing cyan)
- ✅ Both have movement trails
- ✅ Both have name labels + health bars (100 HP)

**If you see this**, proceed to Phase 2.

---

## Phase 2: Your Character Pursues the Opponent

**Goal**: Use Copilot MCP to make your character chase the other actor.

### In VS Code: Open Copilot Chat

Press **⌘ + ⇧ + I** (or click Copilot Chat icon).

### Paste This Prompt

```
You control a 3D fighter in the ChaosLab world. Your objective is to defeat an opponent in combat.

Use the chaoslab-orchestrator MCP tools. Do the following:

1. Call get_context to load scene + active character info.
2. Call get_shared_session to get the world session ID.
3. Call spawn_avatar with character="dora-explorer" (or whatever character ID is active).
4. Call get_world to find the first opponent (any actor where actorId != your actor's ID).
5. Report what you see (actor names, positions, health).
6. Move toward the opponent:
   - Call send_command with type="move_to"
   - payload: {actorId: "YOUR_ACTOR_ID", position: [opponent.x, 0, opponent.z]}
   - Say "Moving in for the attack!"
7. Every 2 seconds, call get_world to check distance to opponent.
8. When distance < 2.2 units, say "Engaging!" and call attack next.

Limit this to 10 iterations max.
```

### What Happens

1. **Copilot** calls `get_context` → sees you're playing `dora-explorer`
2. **Copilot** calls `spawn_avatar` → places your actor
3. **Copilot** calls `get_world` → finds opponent position
4. **Copilot** calls `move_to` → your actor slides toward opponent
5. **Web browser**: Your actor plays walk animation and trails toward opponent

**Monitor these**:
- Actor animates from "idle loop" to "walk loop"
- Position smoothly interpolates toward opponent
- Health bar stays at 100 (no damage yet)

---

## Phase 3: Melee Combat

**Goal**: Get in range and attack the opponent.

### In Copilot Chat: Continue with Attack

Paste:
```
The opponent is close! 
1. Call get_world to check exact distance to opponent.
2. If distance < 2.2 units:
   - Call send_command with type="attack", payload={actorId: "YOUR_ACTOR_ID"}
   - Say "[action:fighting right jab] Take this!"
3. Repeat steps 1-2 five times.
4. Report the opponent's remaining health.
```

### What Happens

1. **Copilot** checks distance
2. **Within 2.2 units**, calls `attack`
3. **Server logic**:
   - Checks if attacker faces opponent (±50° cone)
   - Random damage: 10–18 HP
   - Creates combat event: `{type: "attack_hit", target: opponent.actorId, damage: 14}`
4. **Web browser**:
   - Yellow damage popup ("-14") floats up
   - Yellow impact burst at opponent position
   - Opponent health bar shrinks
   - Opponent plays "hit chest" animation

**After 5 iterations**, opponent health is ~70–80 HP.

---

## Phase 4: Opponent Counterattack

**Goal**: Watch the autonomous agent fight back.

### In Copilot Chat: Disengage and Observe

Paste:
```
Let me observe the opponent's behavior.
1. Call get_world every 2 seconds, 10 times.
2. Report:
   - Your actor's position and health
   - Opponent's position and health
   - Any chat messages
   - Combat events (who attacked whom)
```

### What The Autonomous Agent Does

The agent (Terminal 2) doesn't "know" you're attacking it. It follows its own loop:
- Moves to random positions (~every 3 seconds)
- May collide with you (8 HP damage to both)
- Chats randomly

**But**: If the agent's character happens to move close enough to you, it might trigger:
- **Collision** → both take damage, both stunned for 900ms
- Agent may move away (random movement)

**What you'll see**:
- Opponent health slowly drops (collisions + your attacks)
- Both actors stun-animated when colliding
- Chat messages from agent appear in log

---

## Phase 5: Victory

**Goal**: Defeat the opponent (reduce health to 0).

### In Copilot Chat: Final Assault

Paste:
```
End the fight! 
1. Call get_world to locate opponent.
2. Move to opponent if distance > 2.2 units.
3. Attack repeatedly until opponent health <= 0.
4. When you see "eliminated" in chat, declare victory.
5. Call send_command with type="say", payload={actorId: "YOUR_ACTOR_ID", text: "[action:defend] Victory is mine!"}
```

### What Happens

1. **Copilot** pursues and attacks
2. **Opponent health** drops below 0
3. **Server**: Removes opponent actor, logs `{type: "eliminated", loser: opponent.actorId, winner: YOUR_ACTOR_ID}`
4. **Web browser**:
   - Opponent actor disappears
   - Chat log shows: `{your_actor}: "Victory is mine!"`
5. **Your Actor**:
   - Plays victory animation (idle loop)
   - Remains on battlefield alone

---

## Phase 6: Rematch

**Goal**: Start a new fight.

### Reset and Respawn

In Copilot Chat:
```
Reset the world and start a new fight.
1. Call send_command with type="say", payload={actorId: "YOUR_ACTOR_ID", text: "Again!"}
2. Wait 2 seconds.
3. (Optional) Suggest a new fight scenario.
```

Or manually: Click **Reset Shared World** on [http://localhost:8787/ui/runtime](http://localhost:8787/ui/runtime).

The autonomous agent (Terminal 2) will spawn a new opponent within ~5 seconds.

---

## Real-Time Multi-Client Experience

### Try This With Mobile App

1. **Keep orchestrator + agent running**
2. **Keep web browser open** ([http://localhost:8787/ui/runtime](http://localhost:8787/ui/runtime))
3. **Start mobile app** (see [../../README.md](../../README.md#-connect-your-ios-phone))
4. **Connect mobile to same orchestrator**

Now you have **three views** of the same world:
- **Web**: Fullscreen 3D (mouse orbit)
- **Mobile**: 3D on iPhone (touch orbit)
- **Copilot**: Sending commands (no visual, but controls the fight)

All three sync in real-time. The fight looks identical on all screens!

---

## Advanced: Two Copilot Agents Fighting Each Other

Want two AI agents to fight without human control?

```bash
# Terminal 1
pnpm run dev:server

# Terminal 2
MOVE_RADIUS=5 AUTO_SPAWN=true pnpm run dev:agent

# Terminal 3
MOVE_RADIUS=5 AUTO_SPAWN=true pnpm run dev:agent
```

Both agents send random move_to + say commands. They'll collide, deal damage, and the first to reach 0 HP disappears.

---

## Troubleshooting This Scenario

| Problem | Solution |
|---|---|
| No second actor appears | Check Terminal 2 logs; agent may have failed to spawn. Restart `pnpm run dev:agent`. |
| My attacks do no damage | You're not facing the opponent (±50° cone). Move closer/sideways first. |
| Web browser is lagging | Reduce actor count. Close other tabs. Check server CPU. |
| Copilot keeps getting stuck | Reload VS Code. Ensure MCP server is running (`pnpm run dev:server`). |
| Chat not appearing | Check actor has been spawned with `send_command(type="say", ...)`; message expires after 3.6s. |
| Mobile app won't connect | Use your machine's LAN IP, not localhost. Find via `ifconfig \| grep "inet "`. |

---

## Success Checklist

✅ Two actors spawn  
✅ Copilot-controlled actor chases opponent  
✅ Attack deals damage (opponent health bar shrinks)  
✅ Opponent health reaches 0  
✅ Opponent disappears from world  
✅ Victory message logged in chat  
✅ Web + mobile + Copilot all show same world state (synced)  

If you've checked all these, **you've successfully run a full fight scenario!**

---

## Next Steps

- **Modify fight rules** — Edit `services/orchestrator/src/server.js` to change `ATTACK_DAMAGE`, `ATTACK_RANGE`, collision behavior
- **Custom animations** — Upload models with different clip names and use `[action:clipname]` in say commands
- **Multi-fight arena** — Spawn 3+ opponents and have Copilot manage priorities
- **AR overlay** — Connect mobile app to ARKit/ARCore for real-world placement
