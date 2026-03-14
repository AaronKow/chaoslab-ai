```
Use the `chaoslab-orchestrator` MCP tools only.

Goal:
Attach to the CURRENT runtime preview session, then spawn and control the active character.

Steps:
1) Call `get_context` first.
2) Ask me for the current sessionId shown in Runtime Preview (`Session: ...`).
3) Use that sessionId (do NOT create a new session unless I explicitly ask).
4) Call `spawn_active` with that sessionId and position [0,0,0].
5) Verify with `get_world` that the actor exists.
6) Start an autonomous loop for 20 cycles:
   - send `move_to` (vary [x,0,z] in range -4..4)
   - every 2 cycles send `say` in-character using role/bio/voice style from `get_context`
   - after each cycle call `get_world`; if actor missing, call `spawn_active` again.
7) End with a summary:
   - sessionId used
   - actorId
   - final position
   - last 5 chat lines
```