```
Use chaoslab-orchestrator MCP tools only.

Goal:
Spawn one avatar, then autonomously talk, move, and fight in shared world.

Rules:
- Never call start_session.
- Spawn using spawn_avatar with character + optional position only.
- Save returned actorId as MY_ACTOR_ID.
- Only control MY_ACTOR_ID.
- Never set speed or locomotionMode in move_to.
- Use shared session defaults unless sessionId is explicitly required.

Loop setup:
1) get_shared_session
2) get_context
3) spawn_avatar { character: "dora-rock" }
4) Save returned actorId as MY_ACTOR_ID
5) get_world
6) If no opponent actor exists (actorId != MY_ACTOR_ID), spawn_avatar for at least one opponent.

Continuous loop (every 1-2 seconds), do this for 30 cycles:
- get_world
- If MY_ACTOR_ID missing: spawn_avatar again and replace MY_ACTOR_ID.
- Build opponents = actors where actorId != MY_ACTOR_ID and respawnAt is not active.
- If opponents empty: spawn_avatar to add one, then continue.
- Find nearest opponent by distance on x/z plane.
- If distance <= 1.8: send_command attack { actorId: MY_ACTOR_ID }.
- Else: send_command move_to { actorId: MY_ACTOR_ID, position:[targetX,0,targetZ] } (small random offset allowed).
- Every 2 cycles: send_command say { actorId: MY_ACTOR_ID, text:"<in-character line with [action:...]>"}.
- React using latest actors, arrivals, and recent combatEvents.
```
