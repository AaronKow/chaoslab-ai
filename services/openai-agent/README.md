# OpenAI Agent

Model-controlled autonomous fighter for ChaosLab.

## Run

Create `.env` from `.env.example` first, then run:

```bash
pnpm run dev:openai-agent
```

The script clears globally exported `OPENAI_API_KEY`/`OPEN_AI_KEY` first, then loads this folder's `.env`.

## Environment

Copy from `.env.example` and set at least:

- `OPENAI_API_KEY`
- `OPENAI_API_KEY` (or `OPEN_AI_KEY`)
- `OPENAI_MODEL` (default: `gpt-4.1-mini`)
- `ORCHESTRATOR_URL` (default: `http://localhost:8787`)

Optional:

- `CHARACTER_ID` to control a specific character id
- `TICK_MS` for loop interval
- `AUTO_SPAWN` to respawn when missing
- `ALLOW_SAY` to disable chat lines
- `SAY_EVERY_N_TICKS` for chat cadence

Note: avoid wrapping API keys in quotes. Use `OPENAI_API_KEY=sk-proj-...`.
