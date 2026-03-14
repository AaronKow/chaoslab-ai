const ORCHESTRATOR_URL = process.env.ORCHESTRATOR_URL || "http://localhost:8787";
const DEVICE_ID = process.env.DEVICE_ID || "mcp-agent";
const TICK_MS = Number(process.env.TICK_MS || 3000);
const CHAT_EVERY_N_TICKS = Number(process.env.CHAT_EVERY_N_TICKS || 3);
const ENABLE_AUTO_SPAWN = process.env.AUTO_SPAWN !== "false";
const MOVE_RADIUS = Number(process.env.MOVE_RADIUS || 4);

let sessionId = process.env.SESSION_ID || "";
let tickCount = 0;
let lastRolePrompt = "";
let stopRequested = false;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const now = () => new Date().toISOString();
const jitter = (range) => (Math.random() * range * 2) - range;

function log(message, meta = "") {
  const suffix = meta ? ` ${meta}` : "";
  console.log(`[${now()}] ${message}${suffix}`);
}

async function request(path, options = {}) {
  const response = await fetch(`${ORCHESTRATOR_URL}${path}`, options);
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return { ok: response.ok, status: response.status, body };
}

async function ensureSession() {
  if (sessionId) {
    return sessionId;
  }
  const response = await request("/session/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ deviceId: DEVICE_ID }),
  });
  if (!response.ok || !response.body?.sessionId) {
    throw new Error(`Failed to start session: ${response.status} ${JSON.stringify(response.body)}`);
  }
  sessionId = response.body.sessionId;
  log("Session started", sessionId);
  return sessionId;
}

async function getMcpContext() {
  const response = await request("/api/mcp/context");
  if (!response.ok) {
    throw new Error(`Failed to fetch /api/mcp/context: ${response.status}`);
  }
  return response.body;
}

async function getWorld(session) {
  const response = await request(`/api/world?sessionId=${encodeURIComponent(session)}`);
  if (!response.ok) {
    throw new Error(`Failed to fetch /api/world: ${response.status}`);
  }
  return response.body;
}

async function spawnActiveCharacter(session) {
  const response = await request(`/api/scene/spawn/${encodeURIComponent(session)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ position: [jitter(1.5), 0, jitter(1.5)] }),
  });
  if (!response.ok) {
    throw new Error(`Failed to spawn active character: ${response.status} ${JSON.stringify(response.body)}`);
  }
  return response.body;
}

async function postControl(session, command) {
  const response = await request(`/control/${encodeURIComponent(session)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(command),
  });
  if (!response.ok) {
    throw new Error(`Failed to POST /control: ${response.status} ${JSON.stringify(response.body)}`);
  }
  return response.body;
}

function nextChatLine(context) {
  const character = context?.scene?.activeCharacter;
  const name = character?.name || "Companion";
  const role = character?.role || "assistant";
  const lines = [
    `I am ${name}. Staying in ${role} mode.`,
    "Adjusting route to keep formation.",
    "Scanning nearby space for interaction points.",
    "Keeping watch and updating movement plan.",
    "I will respond in character as the active entity.",
  ];
  return lines[Math.floor(Math.random() * lines.length)];
}

async function tick() {
  const session = await ensureSession();
  const context = await getMcpContext();
  const activeCharacter = context?.scene?.activeCharacter;

  if (!activeCharacter) {
    log("Waiting for active character in /ui/models...");
    return;
  }

  if (lastRolePrompt !== context?.rolePrompt) {
    lastRolePrompt = context?.rolePrompt || "";
    log("Role context updated", activeCharacter.id);
  }

  const world = await getWorld(session);
  const actorId = activeCharacter.actorId;
  const actor = Array.isArray(world?.actors)
    ? world.actors.find((item) => item.actorId === actorId)
    : null;

  if (!actor && ENABLE_AUTO_SPAWN) {
    await spawnActiveCharacter(session);
    log("Spawned active character", actorId);
    return;
  }

  if (!actor) {
    log("Actor missing and AUTO_SPAWN=false", actorId);
    return;
  }

  const moveCommand = {
    type: "move_to",
    payload: {
      actorId,
      position: [jitter(MOVE_RADIUS), 0, jitter(MOVE_RADIUS)],
      speed: 1.2,
    },
  };
  await postControl(session, moveCommand);
  log("Sent move_to", JSON.stringify(moveCommand.payload.position));

  tickCount += 1;
  if (tickCount % CHAT_EVERY_N_TICKS === 0) {
    const sayCommand = {
      type: "say",
      payload: {
        actorId,
        text: nextChatLine(context),
        bubbleTtlMs: 2800,
      },
    };
    await postControl(session, sayCommand);
    log("Sent say", sayCommand.payload.text);
  }
}

async function run() {
  log("MCP agent boot");
  log("Orchestrator", ORCHESTRATOR_URL);
  log("Tick interval", `${TICK_MS}ms`);
  while (!stopRequested) {
    try {
      await tick();
    } catch (error) {
      log("Tick failed", error?.message || String(error));
    }
    await sleep(TICK_MS);
  }
}

process.on("SIGINT", () => {
  stopRequested = true;
  log("Stopping agent...");
});

process.on("SIGTERM", () => {
  stopRequested = true;
  log("Stopping agent...");
});

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
