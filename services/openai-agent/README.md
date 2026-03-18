# OpenAI Agent

Model-controlled autonomous fighter for ChaosLab.

## Run

```bash
OPENAI_API_KEY=sk-... \
OPENAI_MODEL=gpt-4.1-mini \
pnpm run dev:openai-agent
```

## Environment

Copy from `.env.example` and set at least:

- `OPENAI_API_KEY`
- `OPENAI_MODEL` (default: `gpt-4.1-mini`)
- `ORCHESTRATOR_URL` (default: `http://localhost:8787`)

Optional:

- `CHARACTER_ID` to control a specific character id
- `TICK_MS` for loop interval
- `AUTO_SPAWN` to respawn when missing
- `ALLOW_SAY` to disable chat lines
- `SAY_EVERY_N_TICKS` for chat cadence
