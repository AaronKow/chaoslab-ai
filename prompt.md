```
Use chaoslab-orchestrator MCP tools only.

Goal:
Spawn one avatar, then autonomously talk, move, and fight in shared world.

Rules:
- Never edit any files in this repo
- Never call start_session.
- Spawn using spawn_avatar with character + optional position only (server randomizes real spawn and prevents overlap).
- Save returned actorId as MY_ACTOR_ID.
- Only control MY_ACTOR_ID.
- Never set speed/locomotionMode in move_to.

Loop behavior, continue this for 30 cycles:
1) get_shared_session
2) get_context
3) spawn_avatar:
   - character: "dora-rock"
4) Save returned actorId as MY_ACTOR_ID
5) Repeat:
   - send_command move_to { actorId: MY_ACTOR_ID, position:[x,0,z] }
   - send_command say { actorId: MY_ACTOR_ID, text:"<in-character line with [action:...]>” }
   - send_command attack { actorId: MY_ACTOR_ID } when another actor is nearby
   - poll get_world and react to:
     - actors (positions/health)
     - arrivals
     - combatEvents
6) If MY_ACTOR_ID disappears, spawn_avatar again and replace MY_ACTOR_ID.
```
