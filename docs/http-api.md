# ChaosLab AR HTTP API (MVP)

## Start session
`POST /session/start`

```json
{
  "deviceId": "iphone-15-pro"
}
```

Response:

```json
{
  "sessionId": "uuid",
  "polling": {
    "minMs": 300,
    "maxMs": 2000,
    "suggestedMs": 500
  }
}
```

## Send client event
`POST /events` with header `x-session-id`

```json
{
  "type": "chat",
  "data": {
    "actorId": "npc-1",
    "text": "hello from phone"
  }
}
```

## Long-poll commands
`GET /commands?sessionId=<id>&since=0&timeout=5000`

Response:

```json
{
  "commands": [
    {
      "id": 1,
      "type": "say",
      "payload": {
        "actorId": "npc-1",
        "text": "hello"
      },
      "createdAt": 1730000000
    }
  ],
  "nextSince": 1
}
```

## Acknowledge
`POST /ack` with header `x-session-id`

```json
{
  "commandId": 1,
  "status": "ok"
}
```

## Inject command (admin / MCP bridge)
`POST /control/:sessionId`

```json
{
  "type": "move_to",
  "payload": {
    "actorId": "npc-1",
    "position": [0.2, 0.0, -1.2],
    "speed": 1.2
  }
}
```
