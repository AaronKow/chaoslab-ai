import { createRequire } from "module";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";

// Load .env from the service directory, overriding any shell env vars
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const require = createRequire(import.meta.url);
const dotenv = require("dotenv");
dotenv.config({ path: resolve(__dirname, "../.env"), override: true });

function normalizeSecret(value) {
  if (typeof value !== "string") return "";
  return value.trim().replace(/^"|"$/g, "").replace(/^'|'$/g, "");
}

const ORCHESTRATOR_URL = process.env.ORCHESTRATOR_URL || "http://localhost:8787";
const OPENAI_API_KEY = normalizeSecret(process.env.OPENAI_API_KEY || process.env.OPEN_AI_KEY || "");
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5-nano";
const DEVICE_ID = process.env.DEVICE_ID || "openai-agent";
const CHARACTER_ID = process.env.CHARACTER_ID || "";
const SESSION_ID = process.env.SESSION_ID || "";
const TICK_MS = Number(process.env.TICK_MS || 1800);
const AUTO_SPAWN = process.env.AUTO_SPAWN !== "false";
const ALLOW_SAY = process.env.ALLOW_SAY !== "false";
const SAY_EVERY_N_TICKS = Math.max(1, Number(process.env.SAY_EVERY_N_TICKS || 4));
const MAX_MEMORY_EVENTS = Math.max(6, Number(process.env.MAX_MEMORY_EVENTS || 24));

const ATTACK_RANGE = 2.2;

let stopRequested = false;
let sessionId = SESSION_ID;
let selfActorId = "";
let tickCount = 0;
let memoryEvents = [];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const now = () => new Date().toISOString();

function log(message, meta = "") {
  const suffix = meta ? ` ${meta}` : "";
  console.log(`[${now()}] ${message}${suffix}`);
}

function distanceXZ(a, b) {
  const ax = Number(a?.[0] || 0);
  const az = Number(a?.[2] || 0);
  const bx = Number(b?.[0] || 0);
  const bz = Number(b?.[2] || 0);
  return Math.hypot(ax - bx, az - bz);
}

function clampPosition(position) {
  const x = Number(position?.[0] || 0);
  const z = Number(position?.[2] || position?.[1] || 0);
  const sx = Number.isFinite(x) ? Math.max(-20, Math.min(20, x)) : 0;
  const sz = Number.isFinite(z) ? Math.max(-20, Math.min(20, z)) : 0;
  return [Number(sx.toFixed(2)), 0, Number(sz.toFixed(2))];
}

function safeText(value, fallback = "") {
  return typeof value === "string" ? value.trim() : fallback;
}

function pushMemoryEvent(item) {
  if (!item) return;
  memoryEvents.push(item);
  if (memoryEvents.length > MAX_MEMORY_EVENTS) {
    memoryEvents = memoryEvents.slice(-MAX_MEMORY_EVENTS);
  }
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
  if (sessionId) return sessionId;

  const response = await request("/api/session/shared");

  if (!response.ok || !response.body?.sessionId) {
    throw new Error(`Failed to start shared session: ${response.status} ${JSON.stringify(response.body)}`);
  }

  sessionId = response.body.sessionId;
  log("Session started", sessionId);
  return sessionId;
}

async function getContext() {
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

function resolveSelfActor(world, context) {
  const actors = Array.isArray(world?.actors) ? world.actors : [];
  const preferredModelName = safeText(context?.scene?.activeModel);

  if (selfActorId) {
    const existing = actors.find((actor) => actor.actorId === selfActorId);
    if (existing) return existing;
  }

  const preferredCharacterId = safeText(CHARACTER_ID) || safeText(context?.scene?.activeCharacter?.id);
  if (preferredCharacterId) {
    const byCharacter = preferredModelName
      ? actors.find(
          (actor) =>
            safeText(actor.characterId) === preferredCharacterId &&
            safeText(actor.modelName) === preferredModelName,
        )
      : actors.find((actor) => safeText(actor.characterId) === preferredCharacterId);
    if (byCharacter) {
      selfActorId = byCharacter.actorId;
      return byCharacter;
    }
  }

  const preferredActorId = safeText(context?.scene?.activeCharacter?.actorId);
  if (preferredActorId) {
    const byActor = actors.find((actor) => actor.actorId === preferredActorId);
    if (byActor) {
      selfActorId = byActor.actorId;
      return byActor;
    }
  }

  return null;
}

function findNearestOpponent(world, actorId, selfPosition) {
  const actors = Array.isArray(world?.actors) ? world.actors : [];
  let best = null;
  let bestDist = Infinity;

  for (const actor of actors) {
    if (!actor?.actorId || actor.actorId === actorId) continue;
    const dist = distanceXZ(selfPosition, actor.position);
    if (dist < bestDist) {
      best = actor;
      bestDist = dist;
    }
  }

  return { opponent: best, distance: Number(bestDist.toFixed(3)) };
}

async function spawnActor(session, context) {
  const preferredCharacterId = safeText(CHARACTER_ID) || safeText(context?.scene?.activeCharacter?.id);
  const preferredModelName = safeText(context?.scene?.activeModel);

  if (preferredCharacterId) {
    const response = await postControl(session, {
      type: "spawn",
      payload: {
        modelName: preferredModelName,
        characterId: preferredCharacterId,
        name: context?.scene?.activeCharacter?.name || preferredCharacterId,
        role: context?.scene?.activeCharacter?.role || "fighter",
      },
    });
    const actorId = safeText(response?.command?.payload?.actorId);
    if (actorId) {
      selfActorId = actorId;
    }
    return actorId;
  }

  const response = await request(`/api/scene/spawn/${encodeURIComponent(session)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });

  if (!response.ok) {
    throw new Error(`Failed to spawn active character: ${response.status} ${JSON.stringify(response.body)}`);
  }

  const actorId = safeText(response?.body?.command?.payload?.actorId);
  if (actorId) {
    selfActorId = actorId;
  }
  return actorId;
}

function summarizeWorldForModel(context, selfActor, opponent, opponentDistance, world) {
  const actors = Array.isArray(world?.actors) ? world.actors : [];
  const chats = Array.isArray(world?.chats) ? world.chats : [];
  const events = Array.isArray(world?.combatEvents) ? world.combatEvents : [];

  const compactActors = actors.slice(0, 10).map((actor) => ({
    actorId: actor.actorId,
    characterId: actor.characterId,
    health: Number(actor.health || 0),
    position: clampPosition(actor.position),
    animation: safeText(actor.currentAnimation),
  }));

  const recentChats = chats.slice(-4).map((chat) => ({
    actorId: chat.actorId,
    text: safeText(chat.text),
    at: chat.at,
  }));

  const recentCombat = events.slice(-6).map((event) => ({
    type: event.type,
    attacker: event.attacker || event.actorId,
    target: event.target || event.by || null,
    damage: event.damage || null,
    at: event.at,
  }));

  return {
    policy: {
      allowedActions: ["move_to", "attack", "say", "idle"],
      attackRange: ATTACK_RANGE,
      constraints: [
        "Only one action this tick.",
        "Do not invent actor IDs.",
        "For move_to include position [x,0,z].",
        "Attack only when opponent in range.",
        "Say line must be short in-character taunt.",
      ],
    },
    self: {
      actorId: selfActor.actorId,
      health: Number(selfActor.health || 0),
      position: clampPosition(selfActor.position),
      characterId: safeText(selfActor.characterId),
    },
    nearestOpponent: opponent
      ? {
          actorId: opponent.actorId,
          health: Number(opponent.health || 0),
          position: clampPosition(opponent.position),
          distance: opponentDistance,
        }
      : null,
    scene: {
      activeCharacterId: safeText(context?.scene?.activeCharacter?.id),
      activeCharacterName: safeText(context?.scene?.activeCharacter?.name),
      rolePrompt: safeText(context?.rolePrompt),
    },
    recentActors: compactActors,
    recentChats,
    recentCombat,
    memoryEvents,
  };
}

function extractResponseText(body) {
  if (typeof body?.output_text === "string" && body.output_text.trim()) {
    return body.output_text.trim();
  }

  const output = Array.isArray(body?.output) ? body.output : [];
  const chunks = [];
  for (const item of output) {
    const content = Array.isArray(item?.content) ? item.content : [];
    for (const part of content) {
      if (typeof part?.text === "string" && part.text.trim()) {
        chunks.push(part.text.trim());
      }
    }
  }
  return chunks.join("\n").trim();
}

function tryParseJson(text) {
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch {
    // Continue with extraction.
  }

  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;

  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

async function askModelForAction(worldSummary) {
  if (!OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is missing");
  }

  const input = [
    {
      role: "system",
      content: [
        {
          type: "input_text",
          text: [
            "You control a fighter in a 3D world.",
            "Return exactly one JSON object and no markdown.",
            "Schema:",
            '{"action":"move_to|attack|say|idle","position":[x,0,z],"text":"short line","reason":"brief"}',
            "Only include position for move_to.",
            "Only include text for say.",
          ].join("\n"),
        },
      ],
    },
    {
      role: "user",
      content: [{ type: "input_text", text: JSON.stringify(worldSummary) }],
    },
  ];

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      input,
      // Prevent hidden reasoning from consuming all tokens on small models.
      reasoning: { effort: "minimal" },
      text: {
        format: {
          type: "json_schema",
          name: "fighter_action",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              action: { type: "string", enum: ["move_to", "attack", "say", "idle"] },
              position: {
                anyOf: [
                  {
                    type: "array",
                    minItems: 3,
                    maxItems: 3,
                    items: { type: "number" },
                  },
                  { type: "null" },
                ],
              },
              text: { anyOf: [{ type: "string" }, { type: "null" }] },
              reason: { type: "string" },
            },
            required: ["action", "position", "text", "reason"],
          },
        },
      },
      max_output_tokens: 1024,
    }),
  });

  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }

  if (!response.ok) {
    throw new Error(`OpenAI API error: ${response.status} ${body?.error?.message || JSON.stringify(body)}`);
  }

  const text = extractResponseText(body);
  const parsed = tryParseJson(text);
  if (!parsed) {
    throw new Error(
      `Model returned non-JSON output: ${text || "<empty>"}; status=${safeText(body?.status, "unknown")}`,
    );
  }
  return parsed;
}

function sanitizeAction(rawAction, selfActor, nearestOpponent, distance, tick) {
  const action = safeText(rawAction?.action).toLowerCase();

  if (!nearestOpponent) {
    if (action === "say" && ALLOW_SAY && tick % SAY_EVERY_N_TICKS === 0) {
      return { action: "say", text: safeText(rawAction?.text, "I am searching for opponents.") };
    }
    const roam = clampPosition([
      Number(selfActor.position?.[0] || 0) + (Math.random() * 4 - 2),
      0,
      Number(selfActor.position?.[2] || 0) + (Math.random() * 4 - 2),
    ]);
    return { action: "move_to", position: roam, reason: "No opponent visible" };
  }

  if (distance <= ATTACK_RANGE) {
    if (action === "say" && ALLOW_SAY && tick % SAY_EVERY_N_TICKS === 0) {
      return { action: "say", text: safeText(rawAction?.text, "[action:defend] You are done.") };
    }
    return { action: "attack", reason: "Opponent in range" };
  }

  if (action === "say" && ALLOW_SAY && tick % SAY_EVERY_N_TICKS === 0) {
    return { action: "say", text: safeText(rawAction?.text, "I am coming for you.") };
  }

  if (action === "move_to" && Array.isArray(rawAction?.position)) {
    return { action: "move_to", position: clampPosition(rawAction.position), reason: safeText(rawAction?.reason) };
  }

  return {
    action: "move_to",
    position: clampPosition(nearestOpponent.position),
    reason: "Close distance to target",
  };
}

async function executeAction(session, actorId, action) {
  if (action.action === "move_to") {
    await postControl(session, {
      type: "move_to",
      payload: { actorId, position: clampPosition(action.position) },
    });
    log("Action move_to", JSON.stringify(action.position));
    return;
  }

  if (action.action === "attack") {
    await postControl(session, {
      type: "attack",
      payload: { actorId },
    });
    log("Action attack", actorId);
    return;
  }

  if (action.action === "say" && ALLOW_SAY) {
    await postControl(session, {
      type: "say",
      payload: {
        actorId,
        text: safeText(action.text, "[action:defend] Prepare yourself."),
        bubbleTtlMs: 2600,
      },
    });
    log("Action say", safeText(action.text));
    return;
  }

  log("Action idle");
}

async function tick() {
  const session = await ensureSession();
  const [context, world] = await Promise.all([getContext(), getWorld(session)]);

  let self = resolveSelfActor(world, context);

  if (!self && AUTO_SPAWN) {
    const newActorId = await spawnActor(session, context);
    log("Spawned actor", newActorId || "<unknown>");
    pushMemoryEvent({ at: now(), type: "spawn", actorId: newActorId || null });
    return;
  }

  if (!self) {
    log("No controlled actor found; AUTO_SPAWN=false");
    return;
  }

  const nearest = findNearestOpponent(world, self.actorId, self.position);
  const summary = summarizeWorldForModel(context, self, nearest.opponent, nearest.distance, world);

  let modelAction = null;
  try {
    modelAction = await askModelForAction(summary);
  } catch (error) {
    log("Model decision failed", error?.message || String(error));
  }

  tickCount += 1;
  const safeAction = sanitizeAction(modelAction || {}, self, nearest.opponent, nearest.distance, tickCount);
  await executeAction(session, self.actorId, safeAction);

  pushMemoryEvent({
    at: now(),
    actorId: self.actorId,
    action: safeAction.action,
    reason: safeText(safeAction.reason),
    target: nearest.opponent?.actorId || null,
    distance: Number.isFinite(nearest.distance) ? nearest.distance : null,
  });
}

async function run() {
  log("OpenAI agent boot");
  log("Orchestrator", ORCHESTRATOR_URL);
  log("Model", OPENAI_MODEL);
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
