import express from "express";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promises as fsp } from "node:fs";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8787;
const SESSION_TTL_MS = 1000 * 60 * 30;
const SHARED_SESSION_ID = "shared-main";
const SHARED_DEVICE_ID = "shared-runtime";
const SHARED_SESSION_ALIASES = new Set(["shared-main", "shared-session", "shared"]);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "../../..");
const MODELS_DIR = path.join(REPO_ROOT, "assets", "models");
const PUBLIC_MODELS_PATH = "/assets/models";
const CHARACTERS_PATH = path.join(MODELS_DIR, "characters.json");
const SCENE_STATE_PATH = path.join(MODELS_DIR, "scene-state.json");
const ALLOWED_MODEL_EXTENSIONS = new Set([".glb", ".gltf", ".usdz", ".usdc", ".obj", ".fbx"]);

fs.mkdirSync(MODELS_DIR, { recursive: true });
app.use(PUBLIC_MODELS_PATH, express.static(MODELS_DIR));

/** @type {Map<string, {deviceId: string, createdAt: number, lastSeenAt: number, cursor: number}>} */
const sessions = new Map();
/** @type {Map<string, Array<{id: number, type: string, payload: Record<string, unknown>, createdAt: number}>>} */
const commandQueues = new Map();
/** @type {Map<string, Array<{commandId: number, executedAt: number, status: string, details?: string}>>} */
const acknowledgements = new Map();
/** @type {Map<string, {actors: Map<string, {actorId: string, modelName: string, characterId?: string, name?: string, role?: string, position: [number, number, number], moveTarget?: [number, number, number] | null, movementSpeed?: number, locomotionMode?: string, currentAnimation?: string, actionUntil?: number, activeMoveId?: number, lastCompletedMoveId?: number, lastUpdatedAt: number, lastChat?: string, radius?: number, health?: number, facingYaw?: number}>, chats: Array<{actorId: string, text: string, at: number}>, arrivals: Array<{actorId: string, moveId: number, at: number, position: [number, number, number]}>, combatEvents: Array<Record<string, unknown>>, collisionCooldowns: Map<string, number>, lastAdvanceAt: number}>} */
const worldStates = new Map();

const newSessionId = () => crypto.randomUUID();
const now = () => Date.now();
const SPAWN_RANGE = 6;
const SPAWN_MIN_GAP = 0.35;
const ACTOR_RADIUS_DEFAULT = 0.55;
const COLLISION_COOLDOWN_MS = 900;
const COLLISION_DAMAGE = 8;
const ATTACK_RANGE = 2.2;
const ATTACK_DAMAGE_MIN = 10;
const ATTACK_DAMAGE_MAX = 18;
const ATTACK_FACING_DOT = 0.64;
const ATTACK_TURN_RATE_RAD = 1.2;
const MOVE_TURN_RATE_RAD_PER_SEC = 5.5;
const MAX_COMBAT_EVENTS = 120;

const sanitizeFilename = (name) =>
  name
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9._-]/g, "");

const toStoredFilename = (originalName) => {
  const ext = path.extname(originalName).toLowerCase();
  if (!ALLOWED_MODEL_EXTENSIONS.has(ext)) {
    throw new Error(`Unsupported model extension: ${ext || "unknown"}`);
  }
  const safeBase = sanitizeFilename(path.basename(originalName, ext)) || "model";
  return `${safeBase}-${Date.now()}${ext}`;
};

const toSafeText = (value, fallback = "") => {
  if (typeof value !== "string") {
    return fallback;
  }
  return value.trim();
};

const createCharacterId = (rawId, rawName) => {
  const direct = sanitizeFilename(toSafeText(rawId));
  if (direct) {
    return direct;
  }
  const fromName = sanitizeFilename(toSafeText(rawName));
  if (fromName) {
    return fromName;
  }
  return `character-${Date.now()}`;
};

async function readJsonFile(filePath, fallback) {
  try {
    const raw = await fsp.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

async function writeJsonFile(filePath, value) {
  await fsp.writeFile(filePath, JSON.stringify(value, null, 2));
}

async function readCharacterRegistry() {
  const raw = await readJsonFile(CHARACTERS_PATH, {});
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }
  const normalized = {};
  for (const [modelName, characters] of Object.entries(raw)) {
    if (!Array.isArray(characters)) {
      normalized[modelName] = [];
      continue;
    }
    normalized[modelName] = characters
      .map((character) => ({
        id: createCharacterId(character?.id, character?.name),
        actorId: createCharacterId(character?.actorId, character?.id || character?.name),
        name: toSafeText(character?.name, "Unnamed Character"),
        role: toSafeText(character?.role),
        bio: toSafeText(character?.bio),
        voiceStyle: toSafeText(character?.voiceStyle),
      }))
      .filter((character) => character.id);
  }
  return normalized;
}

async function readSceneState() {
  const raw = await readJsonFile(SCENE_STATE_PATH, {});
  return {
    activeModel: toSafeText(raw?.activeModel, ""),
    activeCharacterId: toSafeText(raw?.activeCharacterId, ""),
    updatedAt: typeof raw?.updatedAt === "number" ? raw.updatedAt : 0,
  };
}

function normalizeCharacterInput(input) {
  const id = createCharacterId(input?.id, input?.name);
  const actorId = createCharacterId(input?.actorId, input?.name || input?.id);
  return {
    id,
    actorId,
    name: toSafeText(input?.name, "Unnamed Character"),
    role: toSafeText(input?.role),
    bio: toSafeText(input?.bio),
    voiceStyle: toSafeText(input?.voiceStyle),
  };
}

async function listModels() {
  const files = await fsp.readdir(MODELS_DIR, { withFileTypes: true });
  const models = [];
  for (const file of files) {
    if (!file.isFile()) {
      continue;
    }
    const ext = path.extname(file.name).toLowerCase();
    if (!ALLOWED_MODEL_EXTENSIONS.has(ext)) {
      continue;
    }
    const fullPath = path.join(MODELS_DIR, file.name);
    const stats = await fsp.stat(fullPath);
    models.push({
      name: file.name,
      extension: ext,
      sizeBytes: stats.size,
      updatedAt: stats.mtimeMs,
      url: `${PUBLIC_MODELS_PATH}/${encodeURIComponent(file.name)}`,
      projectPath: path.relative(REPO_ROOT, fullPath),
      previewable: ext === ".glb" || ext === ".gltf",
    });
  }
  models.sort((a, b) => b.updatedAt - a.updatedAt);
  return models;
}

function getModelByName(models, modelName) {
  return models.find((model) => model.name === modelName);
}

function withCharacters(models, registry) {
  return models.map((model) => ({
    ...model,
    characters: Array.isArray(registry[model.name]) ? registry[model.name] : [],
  }));
}

function createSceneSnapshot(models, registry, sceneState) {
  const activeModel = getModelByName(models, sceneState.activeModel) || null;
  const activeCharacters = activeModel ? registry[activeModel.name] || [] : [];
  const activeCharacter = activeCharacters.find((character) => character.id === sceneState.activeCharacterId) || null;
  return {
    activeModel: activeModel?.name || "",
    activeCharacterId: activeCharacter?.id || "",
    activeCharacter,
    modelUrl: activeModel?.url || "",
    updatedAt: sceneState.updatedAt || 0,
  };
}

function requireSession(req, res, next) {
  const requestedSessionId = req.header("x-session-id") || req.body?.sessionId || req.query?.sessionId;
  const sessionId = resolveSessionIdInput(requestedSessionId);
  if (!sessions.has(sessionId)) {
    return res.status(401).json({ error: "Missing or invalid session" });
  }
  const session = sessions.get(sessionId);
  if (now() - session.lastSeenAt > SESSION_TTL_MS) {
    sessions.delete(sessionId);
    commandQueues.delete(sessionId);
    acknowledgements.delete(sessionId);
    worldStates.delete(sessionId);
    return res.status(401).json({ error: "Session expired" });
  }
  session.lastSeenAt = now();
  req.sessionId = sessionId;
  next();
}

function resolveSessionIdInput(inputSessionId) {
  const requested = toSafeText(inputSessionId);
  if (!requested) {
    return ensureSharedSession();
  }
  if (SHARED_SESSION_ALIASES.has(requested)) {
    return ensureSharedSession();
  }
  return requested;
}

function createSessionRecord(sessionId, deviceId) {
  const initialTimestamp = now();
  sessions.set(sessionId, {
    deviceId,
    createdAt: initialTimestamp,
    lastSeenAt: initialTimestamp,
    cursor: 0,
  });
  commandQueues.set(sessionId, []);
  acknowledgements.set(sessionId, []);
  worldStates.set(sessionId, {
    actors: new Map(),
    chats: [],
    arrivals: [],
    combatEvents: [],
    collisionCooldowns: new Map(),
    lastAdvanceAt: now(),
  });
  return {
    sessionId,
    polling: {
      minMs: 300,
      maxMs: 2000,
      suggestedMs: 500,
    },
  };
}

function ensureSharedSession() {
  const shared = sessions.get(SHARED_SESSION_ID);
  if (!shared) {
    createSessionRecord(SHARED_SESSION_ID, SHARED_DEVICE_ID);
    return SHARED_SESSION_ID;
  }
  if (now() - shared.lastSeenAt > SESSION_TTL_MS) {
    sessions.delete(SHARED_SESSION_ID);
    commandQueues.delete(SHARED_SESSION_ID);
    acknowledgements.delete(SHARED_SESSION_ID);
    worldStates.delete(SHARED_SESSION_ID);
    createSessionRecord(SHARED_SESSION_ID, SHARED_DEVICE_ID);
  }
  return SHARED_SESSION_ID;
}

function enqueueCommand(sessionId, type, payload) {
  const session = sessions.get(sessionId);
  const appliedPayload = applyCommandToWorld(sessionId, type, payload) || payload;
  const nextId = session.cursor + 1;
  const nextCommand = {
    id: nextId,
    type,
    payload: appliedPayload,
    createdAt: now(),
  };
  session.cursor = nextId;
  commandQueues.get(sessionId).push(nextCommand);
  return nextCommand;
}

function ensureWorldState(sessionId) {
  if (!worldStates.has(sessionId)) {
    worldStates.set(sessionId, {
      actors: new Map(),
      chats: [],
      arrivals: [],
      combatEvents: [],
      collisionCooldowns: new Map(),
      lastAdvanceAt: now(),
    });
  }
  return worldStates.get(sessionId);
}

function normalizePosition(raw) {
  if (!Array.isArray(raw) || raw.length < 3) {
    return [0, 0, 0];
  }
  const x = Number(raw[0]);
  const y = Number(raw[1]);
  const z = Number(raw[2]);
  return [
    Number.isFinite(x) ? x : 0,
    Number.isFinite(y) ? y : 0,
    Number.isFinite(z) ? z : 0,
  ];
}

function normalizeSpeed(rawSpeed, fallback = 1) {
  const speed = Number(rawSpeed);
  if (!Number.isFinite(speed) || speed <= 0) {
    return fallback;
  }
  return speed;
}

function randomBetween(min, max) {
  return min + Math.random() * (max - min);
}

function pairKey(a, b) {
  return [a, b].sort().join("::");
}

function normalizeAngle(angle) {
  let next = Number(angle);
  if (!Number.isFinite(next)) {
    return 0;
  }
  while (next > Math.PI) next -= Math.PI * 2;
  while (next < -Math.PI) next += Math.PI * 2;
  return next;
}

function shortestAngleDelta(from, to) {
  return normalizeAngle(to - from);
}

function turnToward(current, target, maxStep) {
  const safeCurrent = normalizeAngle(current);
  const safeTarget = normalizeAngle(target);
  const safeStep = Math.max(0, Number(maxStep) || 0);
  const delta = shortestAngleDelta(safeCurrent, safeTarget);
  if (Math.abs(delta) <= safeStep) {
    return safeTarget;
  }
  return normalizeAngle(safeCurrent + Math.sign(delta) * safeStep);
}

function yawToTarget(fromPos, toPos) {
  const dx = Number(toPos?.[0] || 0) - Number(fromPos?.[0] || 0);
  const dz = Number(toPos?.[2] || 0) - Number(fromPos?.[2] || 0);
  if (Math.abs(dx) < 0.0001 && Math.abs(dz) < 0.0001) {
    return 0;
  }
  return Math.atan2(dx, dz);
}

function addCombatEvent(world, event) {
  world.combatEvents.push(event);
  if (world.combatEvents.length > MAX_COMBAT_EVENTS) {
    world.combatEvents = world.combatEvents.slice(-MAX_COMBAT_EVENTS);
  }
}

function getActorRadius(actor) {
  return Number(actor?.radius || ACTOR_RADIUS_DEFAULT);
}

function getRandomSpawnPosition(world, ignoreActorId = "") {
  const hasOthers = Array.from(world.actors.values()).some((actor) => actor.actorId !== ignoreActorId);
  if (!hasOthers) {
    return [Number(randomBetween(-SPAWN_RANGE, SPAWN_RANGE).toFixed(2)), 0, Number(randomBetween(-SPAWN_RANGE, SPAWN_RANGE).toFixed(2))];
  }

  let bestCandidate = [0, 0, 0];
  let bestClearance = -Infinity;
  for (let i = 0; i < 40; i += 1) {
    const candidate = [randomBetween(-SPAWN_RANGE, SPAWN_RANGE), 0, randomBetween(-SPAWN_RANGE, SPAWN_RANGE)];
    let clearance = Infinity;
    for (const actor of world.actors.values()) {
      if (actor.actorId === ignoreActorId) {
        continue;
      }
      const dx = candidate[0] - Number(actor.position?.[0] || 0);
      const dz = candidate[2] - Number(actor.position?.[2] || 0);
      const dist = Math.hypot(dx, dz);
      const actorGap = dist - (getActorRadius(actor) + ACTOR_RADIUS_DEFAULT);
      clearance = Math.min(clearance, actorGap);
    }
    if (clearance > bestClearance) {
      bestClearance = clearance;
      bestCandidate = [Number(candidate[0].toFixed(2)), 0, Number(candidate[2].toFixed(2))];
    }
    if (clearance >= SPAWN_MIN_GAP) {
      return [Number(candidate[0].toFixed(2)), 0, Number(candidate[2].toFixed(2))];
    }
  }
  return bestCandidate;
}

function makeRandomActorId(world, baseRaw) {
  const base = sanitizeFilename(toSafeText(baseRaw)) || "actor";
  let actorId = "";
  do {
    const rand = crypto.randomBytes(3).toString("hex");
    actorId = `${base}-${rand}`;
  } while (world.actors.has(actorId));
  return actorId;
}

function inferLocomotionClip(speed) {
  if (speed >= 1.8) {
    return "sprint loop";
  }
  if (speed >= 0.4) {
    return "walk loop";
  }
  return "idle loop";
}

function extractActionTag(text) {
  const value = toSafeText(text);
  const match = value.match(/\[action:([^\]]+)\]/i);
  return toSafeText(match?.[1] || "");
}

function chooseBackendLocomotion() {
  return {
    mode: "walk",
    speed: Number((1.0 + Math.random() * 0.4).toFixed(2)),
    clip: "walk loop",
  };
}

function advanceWorldState(sessionId, at = now()) {
  const world = ensureWorldState(sessionId);
  const previous = Number(world.lastAdvanceAt || at);
  const deltaMs = Math.max(0, at - previous);
  world.lastAdvanceAt = at;
  if (deltaMs <= 0) {
    return;
  }

  for (const actor of world.actors.values()) {
    const target = Array.isArray(actor.moveTarget) ? actor.moveTarget : null;
    if (!target) {
      continue;
    }
    const cx = Number(actor.position?.[0] || 0);
    const cy = 0;
    const cz = Number(actor.position?.[2] || 0);
    const tx = Number(target[0] || 0);
    const ty = 0;
    const tz = Number(target[2] || 0);
    const dx = tx - cx;
    const dy = ty - cy;
    const dz = tz - cz;
    const distance = Math.hypot(dx, dy, dz);
    const desiredYaw = Math.atan2(dx, dz);
    const maxTurn = MOVE_TURN_RATE_RAD_PER_SEC * (deltaMs / 1000);
    actor.facingYaw = turnToward(Number(actor.facingYaw || 0), desiredYaw, maxTurn);

    if (distance <= 0.001) {
      actor.position = [tx, ty, tz];
      actor.moveTarget = null;
      if (Number(actor.activeMoveId || 0) > Number(actor.lastCompletedMoveId || 0)) {
        actor.lastCompletedMoveId = actor.activeMoveId;
        world.arrivals.push({
          actorId: actor.actorId,
          moveId: actor.activeMoveId,
          at,
          position: [tx, ty, tz],
        });
        if (world.arrivals.length > 80) {
          world.arrivals = world.arrivals.slice(-80);
        }
      }
      if ((actor.actionUntil || 0) <= at) {
        actor.currentAnimation = "idle loop";
      }
      actor.lastUpdatedAt = at;
      continue;
    }

    const speed = normalizeSpeed(actor.movementSpeed, 1);
    const step = speed * (deltaMs / 1000);
    if (step >= distance) {
      actor.position = [tx, ty, tz];
      actor.moveTarget = null;
      if (Number(actor.activeMoveId || 0) > Number(actor.lastCompletedMoveId || 0)) {
        actor.lastCompletedMoveId = actor.activeMoveId;
        world.arrivals.push({
          actorId: actor.actorId,
          moveId: actor.activeMoveId,
          at,
          position: [tx, ty, tz],
        });
        if (world.arrivals.length > 80) {
          world.arrivals = world.arrivals.slice(-80);
        }
      }
      if ((actor.actionUntil || 0) <= at) {
        actor.currentAnimation = "idle loop";
      }
      actor.lastUpdatedAt = at;
      continue;
    }

    const ratio = step / distance;
    actor.position = [
      cx + dx * ratio,
      cy + dy * ratio,
      cz + dz * ratio,
    ];
    if ((actor.actionUntil || 0) <= at) {
      actor.currentAnimation = inferLocomotionClip(speed);
    }
    actor.lastUpdatedAt = at;
  }

  const actors = Array.from(world.actors.values());
  for (let i = 0; i < actors.length; i += 1) {
    for (let j = i + 1; j < actors.length; j += 1) {
      const a = actors[i];
      const b = actors[j];
      if (!world.actors.has(a.actorId) || !world.actors.has(b.actorId)) {
        continue;
      }
      const ax = Number(a.position?.[0] || 0);
      const az = Number(a.position?.[2] || 0);
      const bx = Number(b.position?.[0] || 0);
      const bz = Number(b.position?.[2] || 0);
      let dx = bx - ax;
      let dz = bz - az;
      let dist = Math.hypot(dx, dz);
      const minDist = getActorRadius(a) + getActorRadius(b);
      if (dist >= minDist) {
        continue;
      }

      if (dist < 0.0001) {
        const angle = randomBetween(0, Math.PI * 2);
        dx = Math.cos(angle);
        dz = Math.sin(angle);
        dist = 1;
      }

      const nx = dx / dist;
      const nz = dz / dist;
      const penetration = minDist - dist;
      const push = (penetration * 0.5) + 0.04;
      a.position = [ax - nx * push, 0, az - nz * push];
      b.position = [bx + nx * push, 0, bz + nz * push];
      a.moveTarget = null;
      b.moveTarget = null;
      if ((a.actionUntil || 0) <= at) {
        a.currentAnimation = "idle loop";
      }
      if ((b.actionUntil || 0) <= at) {
        b.currentAnimation = "idle loop";
      }
      a.lastUpdatedAt = at;
      b.lastUpdatedAt = at;

      const key = pairKey(a.actorId, b.actorId);
      const lastHitAt = Number(world.collisionCooldowns.get(key) || 0);
      if (at - lastHitAt < COLLISION_COOLDOWN_MS) {
        continue;
      }
      world.collisionCooldowns.set(key, at);
      a.currentAnimation = "hit chest";
      b.currentAnimation = "hit chest";
      a.actionUntil = at + 900;
      b.actionUntil = at + 900;

      const damageA = COLLISION_DAMAGE;
      const damageB = COLLISION_DAMAGE;
      a.health = Math.max(0, Number(a.health || 100) - damageA);
      b.health = Math.max(0, Number(b.health || 100) - damageB);
      addCombatEvent(world, {
        type: "collision_damage",
        at,
        actors: [a.actorId, b.actorId],
        damage: { [a.actorId]: damageA, [b.actorId]: damageB },
        health: { [a.actorId]: a.health, [b.actorId]: b.health },
        positions: {
          [a.actorId]: a.position,
          [b.actorId]: b.position,
        },
      });

      if (a.health <= 0) {
        world.actors.delete(a.actorId);
        addCombatEvent(world, {
          type: "eliminated",
          at,
          actorId: a.actorId,
          by: b.actorId,
          cause: "collision",
        });
      }
      if (b.health <= 0) {
        world.actors.delete(b.actorId);
        addCombatEvent(world, {
          type: "eliminated",
          at,
          actorId: b.actorId,
          by: a.actorId,
          cause: "collision",
        });
      }
    }
  }
}

function applyCommandToWorld(sessionId, type, payload) {
  const world = ensureWorldState(sessionId);
  advanceWorldState(sessionId);
  const requestedActorId = toSafeText(payload?.actorId);
  if (!requestedActorId && type !== "spawn") {
    return;
  }
  const currentActor = requestedActorId ? world.actors.get(requestedActorId) : null;

  if (type === "spawn") {
    const generatedBaseActorId = toSafeText(payload?.characterId) || toSafeText(payload?.name) || toSafeText(payload?.modelName) || "actor";
    const allowReuse = Boolean(payload?.reuseActorId) && Boolean(currentActor);
    const actorId = allowReuse
      ? toSafeText(currentActor.actorId, generatedBaseActorId)
      : makeRandomActorId(world, generatedBaseActorId);
    const nextCharacterId = toSafeText(payload?.characterId, currentActor?.characterId || "");
    const nextModelName = toSafeText(payload?.modelName, currentActor?.modelName || "");
    const nextName = toSafeText(payload?.name, currentActor?.name || actorId);
    const spawnPosition = getRandomSpawnPosition(world, allowReuse ? actorId : "");

    world.actors.set(actorId, {
      actorId,
      modelName: nextModelName,
      characterId: nextCharacterId,
      name: nextName,
      role: toSafeText(payload?.role, currentActor?.role || ""),
      position: spawnPosition,
      moveTarget: null,
      movementSpeed: normalizeSpeed(payload?.speed, currentActor?.movementSpeed || 1),
      locomotionMode: toSafeText(payload?.locomotionMode, currentActor?.locomotionMode || "walk"),
      currentAnimation: toSafeText(payload?.animation, currentActor?.currentAnimation || "idle loop"),
      actionUntil: currentActor?.actionUntil || 0,
      activeMoveId: Number(currentActor?.activeMoveId || 0),
      lastCompletedMoveId: Number(currentActor?.lastCompletedMoveId || 0),
      lastUpdatedAt: now(),
      lastChat: currentActor?.lastChat || "",
      radius: Number(currentActor?.radius || ACTOR_RADIUS_DEFAULT),
      health: Number(currentActor?.health || 100),
      facingYaw: Number(currentActor?.facingYaw || randomBetween(-Math.PI, Math.PI)),
    });
    return {
      ...payload,
      actorId,
      position: spawnPosition,
    };
  }

  if (type === "move_to") {
    if (!currentActor) {
      return;
    }
    const profile = chooseBackendLocomotion();
    const nextMoveId = Number(currentActor.activeMoveId || 0) + 1;
    currentActor.moveTarget = normalizePosition(payload?.position);
    currentActor.activeMoveId = nextMoveId;
    currentActor.movementSpeed = profile.speed;
    currentActor.locomotionMode = profile.mode;
    currentActor.currentAnimation = profile.clip;
    currentActor.lastUpdatedAt = now();
    world.actors.set(requestedActorId, currentActor);
    return payload;
  }

  if (type === "say") {
    if (currentActor) {
      currentActor.lastChat = toSafeText(payload?.text);
      const actionTag = extractActionTag(payload?.text);
      if (actionTag) {
        currentActor.currentAnimation = actionTag;
        currentActor.actionUntil = now() + 2400;
      } else if ((currentActor.actionUntil || 0) <= now()) {
        currentActor.currentAnimation = inferLocomotionClip(currentActor.movementSpeed || 1);
      }
      currentActor.lastUpdatedAt = now();
      world.actors.set(requestedActorId, currentActor);
    }
    world.chats.push({
      actorId: requestedActorId,
      text: toSafeText(payload?.text),
      at: now(),
    });
    if (world.chats.length > 50) {
      world.chats = world.chats.slice(-50);
    }
    return payload;
  }

  if (type === "play_animation") {
    if (!currentActor) {
      return;
    }
    const clip = toSafeText(payload?.clip || payload?.name);
    if (!clip) {
      return;
    }
    currentActor.currentAnimation = clip;
    currentActor.actionUntil = now() + Math.max(400, Number(payload?.durationMs) || 2200);
    currentActor.lastUpdatedAt = now();
    world.actors.set(requestedActorId, currentActor);
    return payload;
  }

  if (type === "attack") {
    if (!currentActor) {
      return payload;
    }
    let targetActor = null;
    let nearestDist = Infinity;
    for (const actor of world.actors.values()) {
      if (actor.actorId === currentActor.actorId) {
        continue;
      }
      const dx = Number(actor.position?.[0] || 0) - Number(currentActor.position?.[0] || 0);
      const dz = Number(actor.position?.[2] || 0) - Number(currentActor.position?.[2] || 0);
      const dist = Math.hypot(dx, dz);
      if (dist < nearestDist) {
        nearestDist = dist;
        targetActor = actor;
      }
    }

    const eventAt = now();
    const attackClip = toSafeText(payload?.clip, Math.random() < 0.5 ? "fighting right jab" : "fighting left jab");
    if (targetActor) {
      const targetYaw = yawToTarget(currentActor.position, targetActor.position);
      currentActor.facingYaw = turnToward(
        Number(currentActor.facingYaw || 0),
        targetYaw,
        ATTACK_TURN_RATE_RAD,
      );
    }
    currentActor.currentAnimation = attackClip;
    currentActor.actionUntil = eventAt + 700;
    currentActor.lastUpdatedAt = eventAt;
    world.actors.set(requestedActorId, currentActor);

    if (!targetActor || nearestDist > ATTACK_RANGE) {
      addCombatEvent(world, {
        type: "attack_miss",
        at: eventAt,
        actorId: currentActor.actorId,
        reason: !targetActor ? "no_target" : "out_of_range",
      });
      return payload;
    }

    const desiredYaw = yawToTarget(currentActor.position, targetActor.position);
    const yawDiff = Math.abs(shortestAngleDelta(Number(currentActor.facingYaw || 0), desiredYaw));
    const facingDot = Math.cos(yawDiff);
    if (facingDot < ATTACK_FACING_DOT) {
      addCombatEvent(world, {
        type: "attack_miss",
        at: eventAt,
        actorId: currentActor.actorId,
        target: targetActor.actorId,
        reason: "not_facing",
        yawDiffDeg: Number((yawDiff * 180 / Math.PI).toFixed(1)),
      });
      return payload;
    }

    const damage = Math.floor(randomBetween(ATTACK_DAMAGE_MIN, ATTACK_DAMAGE_MAX + 1));
    targetActor.health = Math.max(0, Number(targetActor.health || 100) - damage);
    targetActor.currentAnimation = "hit chest";
    targetActor.actionUntil = eventAt + 900;
    targetActor.moveTarget = null;
    targetActor.lastUpdatedAt = eventAt;
    if (targetActor.health <= 0) {
      world.actors.delete(targetActor.actorId);
      addCombatEvent(world, {
        type: "eliminated",
        at: eventAt,
        actorId: targetActor.actorId,
        by: currentActor.actorId,
        cause: "attack",
      });
    } else {
      world.actors.set(targetActor.actorId, targetActor);
    }
    addCombatEvent(world, {
      type: "attack_hit",
      at: eventAt,
      attacker: currentActor.actorId,
      target: targetActor.actorId,
      damage,
      targetHealth: targetActor.health,
      targetPosition: targetActor.position,
    });
    return payload;
  }

  return payload;
}

async function resolveActorIdFromPayload(sessionId, payload) {
  const world = ensureWorldState(sessionId);
  const directActorId = toSafeText(payload?.actorId);
  if (directActorId && world.actors.has(directActorId)) {
    return directActorId;
  }

  const characterId = toSafeText(payload?.characterId);
  if (characterId) {
    for (const actor of world.actors.values()) {
      if (toSafeText(actor.characterId) === characterId) {
        return actor.actorId;
      }
    }
  }

  const byName = toSafeText(payload?.name);
  if (byName) {
    for (const actor of world.actors.values()) {
      if (toSafeText(actor.name).toLowerCase() === byName.toLowerCase()) {
        return actor.actorId;
      }
    }
  }

  if (world.actors.size === 1) {
    return Array.from(world.actors.keys())[0];
  }

  const sceneState = await readSceneState();
  if (sceneState.activeCharacterId) {
    const registry = await readCharacterRegistry();
    const characters = Array.isArray(registry[sceneState.activeModel]) ? registry[sceneState.activeModel] : [];
    const activeCharacter = characters.find((character) => character.id === sceneState.activeCharacterId);
    if (activeCharacter?.actorId && world.actors.has(activeCharacter.actorId)) {
      return activeCharacter.actorId;
    }
  }

  return directActorId || "";
}

app.get("/health", (_, res) => {
  const sharedSessionId = ensureSharedSession();
  res.json({ ok: true, sessions: sessions.size, sharedSessionId });
});

app.get("/api/session/shared", (_, res) => {
  const sessionId = ensureSharedSession();
  const session = sessions.get(sessionId);
  session.lastSeenAt = now();
  res.json({
    sessionId,
    shared: true,
    polling: {
      minMs: 300,
      maxMs: 2000,
      suggestedMs: 500,
    },
  });
});

app.get("/", (_, res) => {
  res.type("html").send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>ChaosLab Orchestrator</title>
  <style>
    body { margin: 0; font-family: ui-sans-serif, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; background: #080b12; color: #e4ebff; }
    main { max-width: 760px; margin: 0 auto; padding: 36px 20px; }
    h1 { margin-top: 0; }
    .card { background: #101726; border: 1px solid #1f2d47; border-radius: 12px; padding: 16px; margin-top: 14px; }
    a { color: #83d8ff; text-decoration: none; }
    a:hover { text-decoration: underline; }
    code { background: #19253a; border-radius: 6px; padding: 1px 5px; }
    p { color: #95a3bf; }
  </style>
</head>
<body>
  <main>
    <h1>ChaosLab Orchestrator</h1>
    <p>Server is running. Use these links:</p>
    <div class="card">
      <p><a href="/ui/models">Open Model Manager UI</a></p>
      <p><a href="/ui/runtime">Open Runtime Preview (Spawn/Move/Chat)</a></p>
      <p><a href="/health">Health Check JSON</a></p>
      <p><a href="/api/models">Model List JSON</a></p>
      <p><a href="/api/mcp/context">MCP Role Context JSON</a></p>
    </div>
    <p>Model files are stored in <code>assets/models</code>.</p>
  </main>
</body>
</html>`);
});

app.get("/api/models", async (_, res) => {
  try {
    const [models, registry, sceneState] = await Promise.all([
      listModels(),
      readCharacterRegistry(),
      readSceneState(),
    ]);
    res.json({
      models: withCharacters(models, registry),
      scene: createSceneSnapshot(models, registry, sceneState),
      modelsDir: path.relative(REPO_ROOT, MODELS_DIR),
      charactersPath: path.relative(REPO_ROOT, CHARACTERS_PATH),
      sceneStatePath: path.relative(REPO_ROOT, SCENE_STATE_PATH),
    });
  } catch (error) {
    res.status(500).json({ error: "Failed to list models", details: error.message });
  }
});

app.post("/api/models/:modelName/characters", async (req, res) => {
  try {
    const modelName = req.params.modelName;
    const models = await listModels();
    if (!getModelByName(models, modelName)) {
      return res.status(404).json({ error: `Model not found: ${modelName}` });
    }
    const character = normalizeCharacterInput(req.body || {});
    const registry = await readCharacterRegistry();
    const current = Array.isArray(registry[modelName]) ? registry[modelName] : [];
    const existingIndex = current.findIndex((item) => item.id === character.id);
    if (existingIndex >= 0) {
      current[existingIndex] = character;
    } else {
      current.push(character);
    }
    registry[modelName] = current;
    await writeJsonFile(CHARACTERS_PATH, registry);
    res.status(201).json({ saved: character, modelName });
  } catch (error) {
    res.status(400).json({ error: error.message || "Failed to save character" });
  }
});

app.delete("/api/models/:modelName/characters/:characterId", async (req, res) => {
  try {
    const modelName = req.params.modelName;
    const characterId = req.params.characterId;
    const registry = await readCharacterRegistry();
    const current = Array.isArray(registry[modelName]) ? registry[modelName] : [];
    registry[modelName] = current.filter((character) => character.id !== characterId);
    await writeJsonFile(CHARACTERS_PATH, registry);

    const sceneState = await readSceneState();
    if (sceneState.activeModel === modelName && sceneState.activeCharacterId === characterId) {
      await writeJsonFile(SCENE_STATE_PATH, {
        ...sceneState,
        activeCharacterId: "",
        updatedAt: now(),
      });
    }
    res.status(202).json({ removed: true, modelName, characterId });
  } catch (error) {
    res.status(400).json({ error: error.message || "Failed to delete character" });
  }
});

app.get("/api/scene", async (_, res) => {
  try {
    const [models, registry, sceneState] = await Promise.all([
      listModels(),
      readCharacterRegistry(),
      readSceneState(),
    ]);
    res.json({
      scene: createSceneSnapshot(models, registry, sceneState),
    });
  } catch (error) {
    res.status(500).json({ error: "Failed to load scene state", details: error.message });
  }
});

app.put("/api/scene", async (req, res) => {
  try {
    const requestedModel = toSafeText(req.body?.activeModel);
    const requestedCharacter = toSafeText(req.body?.activeCharacterId);
    const [models, registry] = await Promise.all([listModels(), readCharacterRegistry()]);

    if (requestedModel && !getModelByName(models, requestedModel)) {
      return res.status(404).json({ error: `Model not found: ${requestedModel}` });
    }
    if (requestedCharacter) {
      const characters = requestedModel ? registry[requestedModel] || [] : [];
      if (!characters.find((character) => character.id === requestedCharacter)) {
        return res.status(404).json({ error: `Character not found on model ${requestedModel}: ${requestedCharacter}` });
      }
    }

    const sceneState = {
      activeModel: requestedModel,
      activeCharacterId: requestedCharacter,
      updatedAt: now(),
    };
    await writeJsonFile(SCENE_STATE_PATH, sceneState);
    res.status(202).json({
      scene: createSceneSnapshot(models, registry, sceneState),
    });
  } catch (error) {
    res.status(400).json({ error: error.message || "Failed to save scene state" });
  }
});

app.get("/api/mcp/context", async (_, res) => {
  try {
    const [models, registry, sceneState] = await Promise.all([
      listModels(),
      readCharacterRegistry(),
      readSceneState(),
    ]);
    const scene = createSceneSnapshot(models, registry, sceneState);
    const rolePrompt = scene.activeCharacter
      ? `You are ${scene.activeCharacter.name} (${scene.activeCharacter.id}) on model ${scene.activeModel}. Role: ${scene.activeCharacter.role || "not specified"}. Bio: ${scene.activeCharacter.bio || "not specified"}. Voice style: ${scene.activeCharacter.voiceStyle || "not specified"}. Use actorId ${scene.activeCharacter.actorId}.`
      : "No active character is selected. Ask the operator to set active model + character in /ui/models.";

    res.json({
      scene,
      rolePrompt,
      commandSchema: [
        { type: "spawn", payload: { modelName: "string", characterId: "string(optional)", name: "string(optional)", role: "string(optional)" } },
        { type: "say", payload: { actorId: "string", text: "string", bubbleTtlMs: "number(optional)" } },
        { type: "move_to", payload: { actorId: "string", position: "[x,y,z]" } },
        { type: "play_animation", payload: { actorId: "string", clip: "string", durationMs: "number(optional)" } },
        { type: "attack", payload: { actorId: "string", clip: "string(optional)" } },
      ],
      targetEndpoint: "POST /control (shared session default) or POST /control/:sessionId",
      autonomyLoop: [
        "Read /api/mcp/context.",
        "Spawn without actorId/position; backend assigns random non-overlapping spawn and unique actorId.",
        "Ensure there is at least one opponent in the same session (spawn_avatar if needed).",
        "Poll /api/world every cycle, find nearest opponent, and choose action by distance.",
        "If nearest opponent is within attack range, send attack; otherwise send move_to toward that opponent.",
        "When moving, send move_to with destination only. Backend chooses walk/sprint and speed automatically.",
        "Use say periodically for in-character narration and use arrivals/combatEvents to react in real time.",
        "Continue the loop with move_to/say/attack/play_animation for the same actorId.",
      ],
      animationPolicy: {
        requiredLocomotion: ["idle loop", "walk loop", "sprint loop"],
        actionSet: [
          "hit chest",
          "hit knockback rm",
          "fighting right jab",
          "fighting left jab",
          "defend",
          "dizzy",
          "jump start",
          "jump land",
          "jumping jacks",
          "dance loop",
          "backflip",
          "meditate",
        ],
        instruction: "Backend chooses walk/sprint automatically on move_to (70/30). AI should not set speed for locomotion. Use [action:<name>] tags in say text for traceability.",
      },
      physicsPolicy: {
        spawn: "Server randomizes spawn position and avoids overlap.",
        movement: "Actors move continuously over time toward move_to targets. No teleport jumps are allowed.",
        collision: "Actors bounce on collision, take damage, and play hit reactions.",
        combat: "Attack only lands when target is in range and inside the actor's forward punch arc.",
      },
    });
  } catch (error) {
    res.status(500).json({ error: "Failed to build MCP context", details: error.message });
  }
});

app.get("/api/world", requireSession, (req, res) => {
  advanceWorldState(req.sessionId);
  const world = ensureWorldState(req.sessionId);
  const currentTime = now();
  for (const actor of world.actors.values()) {
    if ((actor.actionUntil || 0) > 0 && actor.actionUntil <= currentTime) {
      actor.actionUntil = 0;
      actor.currentAnimation = Array.isArray(actor.moveTarget) ? inferLocomotionClip(actor.movementSpeed || 1) : "idle loop";
      actor.lastUpdatedAt = currentTime;
    }
  }
  res.json({
    sessionId: req.sessionId,
    actors: Array.from(world.actors.values()),
    chats: world.chats,
    arrivals: world.arrivals,
    combatEvents: world.combatEvents,
    updatedAt: now(),
  });
});

app.post("/api/world/reset", (req, res) => {
  const sessionId = ensureSharedSession();
  worldStates.set(sessionId, {
    actors: new Map(),
    chats: [],
    arrivals: [],
    combatEvents: [],
    collisionCooldowns: new Map(),
    lastAdvanceAt: now(),
  });
  commandQueues.set(sessionId, []);
  acknowledgements.set(sessionId, []);
  const session = sessions.get(sessionId);
  if (session) {
    session.cursor = 0;
    session.lastSeenAt = now();
  }
  res.status(202).json({ reset: true, sessionId, shared: true });
});

async function spawnSceneIntoSession(sessionId, spawnPosition) {
  const [models, registry, sceneState] = await Promise.all([
    listModels(),
    readCharacterRegistry(),
    readSceneState(),
  ]);
  const scene = createSceneSnapshot(models, registry, sceneState);
  if (!scene.activeModel || !scene.activeCharacter) {
    return { error: "No active model/character selected. Configure in /ui/models first." };
  }
  const command = enqueueCommand(sessionId, "spawn", {
    actorId: scene.activeCharacter.actorId,
    modelName: scene.activeModel,
    characterId: scene.activeCharacter.id,
    name: scene.activeCharacter.name,
    role: scene.activeCharacter.role,
    position: Array.isArray(spawnPosition) ? spawnPosition : [0, 0, 0],
  });
  return { command, scene };
}

app.post("/api/scene/spawn/:sessionId", async (req, res) => {
  try {
    const sessionId = resolveSessionIdInput(req.params.sessionId);
    if (!sessions.has(sessionId)) {
      return res.status(404).json({ error: "session not found" });
    }
    const spawned = await spawnSceneIntoSession(sessionId, req.body?.position);
    if (spawned.error) {
      return res.status(400).json({ error: spawned.error });
    }
    res.status(201).json(spawned);
  } catch (error) {
    res.status(400).json({ error: error.message || "Failed to spawn active character" });
  }
});

app.post("/api/scene/spawn", async (req, res) => {
  try {
    const sessionId = ensureSharedSession();
    const spawned = await spawnSceneIntoSession(sessionId, req.body?.position);
    if (spawned.error) {
      return res.status(400).json({ error: spawned.error });
    }
    res.status(201).json({ ...spawned, sessionId, shared: true });
  } catch (error) {
    res.status(400).json({ error: error.message || "Failed to spawn active character" });
  }
});

app.post("/api/models/upload", express.raw({ type: "application/octet-stream", limit: "500mb" }), async (req, res) => {
  try {
    const originalName = req.header("x-filename");
    if (!originalName || typeof originalName !== "string") {
      return res.status(400).json({ error: "x-filename header is required" });
    }
    if (!req.body || !Buffer.isBuffer(req.body) || req.body.length === 0) {
      return res.status(400).json({ error: "Upload body is empty" });
    }
    const filename = toStoredFilename(originalName);
    const fullPath = path.join(MODELS_DIR, filename);
    await fsp.writeFile(fullPath, req.body);
    const ext = path.extname(filename).toLowerCase();
    res.status(201).json({
      uploaded: {
        name: filename,
        extension: ext,
        sizeBytes: req.body.length,
        url: `${PUBLIC_MODELS_PATH}/${encodeURIComponent(filename)}`,
        projectPath: path.relative(REPO_ROOT, fullPath),
        previewable: ext === ".glb" || ext === ".gltf",
      },
    });
  } catch (error) {
    res.status(400).json({ error: error.message || "Upload failed" });
  }
});

app.put("/api/models/:modelName/replace", express.raw({ type: "application/octet-stream", limit: "500mb" }), async (req, res) => {
  try {
    const modelName = req.params.modelName;
    const models = await listModels();
    const existing = models.find((model) => model.name === modelName);
    if (!existing) {
      return res.status(404).json({ error: `Model not found: ${modelName}` });
    }
    if (!req.body || !Buffer.isBuffer(req.body) || req.body.length === 0) {
      return res.status(400).json({ error: "Upload body is empty" });
    }

    const incomingName = req.header("x-filename");
    if (incomingName && typeof incomingName === "string") {
      const incomingExt = path.extname(incomingName).toLowerCase();
      const existingExt = path.extname(modelName).toLowerCase();
      if (incomingExt && incomingExt !== existingExt) {
        return res.status(400).json({
          error: `File extension mismatch. Existing model is ${existingExt}, incoming file is ${incomingExt}.`,
        });
      }
    }

    const fullPath = path.join(MODELS_DIR, modelName);
    await fsp.writeFile(fullPath, req.body);
    const stats = await fsp.stat(fullPath);
    const ext = path.extname(modelName).toLowerCase();
    res.status(202).json({
      replaced: {
        name: modelName,
        extension: ext,
        sizeBytes: stats.size,
        updatedAt: stats.mtimeMs,
        url: `${PUBLIC_MODELS_PATH}/${encodeURIComponent(modelName)}`,
        projectPath: path.relative(REPO_ROOT, fullPath),
        previewable: ext === ".glb" || ext === ".gltf",
      },
    });
  } catch (error) {
    res.status(400).json({ error: error.message || "Replace failed" });
  }
});

app.delete("/api/models/:modelName", async (req, res) => {
  try {
    const modelName = req.params.modelName;
    const fullPath = path.join(MODELS_DIR, modelName);
    const ext = path.extname(modelName).toLowerCase();
    if (!ALLOWED_MODEL_EXTENSIONS.has(ext)) {
      return res.status(400).json({ error: `Unsupported model extension: ${ext || "unknown"}` });
    }

    await fsp.unlink(fullPath);

    const registry = await readCharacterRegistry();
    if (registry[modelName]) {
      delete registry[modelName];
      await writeJsonFile(CHARACTERS_PATH, registry);
    }

    const sceneState = await readSceneState();
    if (sceneState.activeModel === modelName) {
      await writeJsonFile(SCENE_STATE_PATH, {
        activeModel: "",
        activeCharacterId: "",
        updatedAt: now(),
      });
    }

    res.status(202).json({ deleted: true, modelName });
  } catch (error) {
    if (error?.code === "ENOENT") {
      return res.status(404).json({ error: "Model not found" });
    }
    res.status(400).json({ error: error.message || "Delete failed" });
  }
});

app.get("/ui/models", (_, res) => {
  res.type("html").send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>ChaosLab Model Manager</title>
  <script type="module" src="https://unpkg.com/@google/model-viewer/dist/model-viewer.min.js"></script>
  <style>
    :root { color-scheme: dark; }
    body { margin: 0; font-family: ui-sans-serif, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; background: #080b12; color: #e4ebff; }
    main { max-width: 1180px; margin: 0 auto; padding: 24px; }
    h1 { margin: 0 0 8px; font-size: 30px; }
    h3 { margin: 14px 0 6px; }
    p { color: #95a3bf; }
    .card { background: #101726; border: 1px solid #1f2d47; border-radius: 12px; padding: 16px; margin-top: 16px; }
    .row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
    .column { display: flex; flex-direction: column; gap: 8px; }
    input[type="file"] { color: #95a3bf; }
    input, textarea, select {
      background: #0a1120;
      border: 1px solid #22324f;
      border-radius: 8px;
      color: #d8e4ff;
      padding: 8px 10px;
      min-width: 220px;
    }
    textarea { min-height: 80px; resize: vertical; }
    button { background: #9fe870; border: none; border-radius: 10px; padding: 10px 14px; font-weight: 600; cursor: pointer; }
    .ghost { background: #24334f; color: #e4ebff; }
    button:disabled { opacity: 0.6; cursor: default; }
    .table { width: 100%; border-collapse: collapse; margin-top: 10px; }
    .table th, .table td { text-align: left; padding: 10px 8px; border-top: 1px solid #1c2940; font-size: 14px; }
    a { color: #83d8ff; text-decoration: none; }
    a:hover { text-decoration: underline; }
    .muted { color: #95a3bf; font-size: 13px; }
    .status { margin-top: 8px; min-height: 20px; color: #95a3bf; }
    model-viewer { width: 100%; height: 420px; background: radial-gradient(circle at top, #202e4a, #0f1522); border-radius: 10px; }
    code { background: #19253a; border-radius: 6px; padding: 1px 5px; }
    pre { background: #0a1120; border: 1px solid #22324f; border-radius: 10px; padding: 12px; overflow: auto; color: #d8e4ff; }
    ul { margin: 6px 0; padding-left: 16px; }
    .grid { display: grid; gap: 12px; grid-template-columns: 1fr 1fr; }
    @media (max-width: 860px) { .grid { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <main>
    <h1>Model Manager</h1>
    <p>Upload models, define per-model characters, and set active role context for MCP/Copilot orchestration.</p>
    <section class="card">
      <h2>Upload</h2>
      <div class="row">
        <input id="file" type="file" accept=".glb,.gltf,.usdz,.usdc,.obj,.fbx" />
        <button id="uploadBtn">Upload Model</button>
      </div>
      <input id="replaceFileInput" type="file" accept=".glb,.gltf,.usdz,.usdc,.obj,.fbx" style="display:none;" />
      <div id="status" class="status"></div>
    </section>

    <section class="card">
      <h2>Preview</h2>
      <model-viewer id="viewer" camera-controls auto-rotate interaction-prompt="none"></model-viewer>
      <p id="viewerHint" class="muted">Select a GLB/GLTF model below to preview it here.</p>
    </section>

    <section class="card">
      <h2>Character Builder</h2>
      <div class="grid">
        <div>
          <div class="row">
            <label class="column">Model
              <select id="charModelSelect"></select>
            </label>
            <label class="column">Character ID
              <input id="charId" placeholder="npc-guard" />
            </label>
            <label class="column">Actor ID (for payload.actorId)
              <input id="actorId" placeholder="npc-guard" />
            </label>
          </div>
          <div class="row">
            <label class="column">Name
              <input id="charName" placeholder="Station Guard" />
            </label>
            <label class="column">Role
              <input id="charRole" placeholder="Security NPC with strict tone" />
            </label>
          </div>
          <div class="row">
            <label class="column">Voice Style
              <input id="charVoice" placeholder="Calm, short answers" />
            </label>
          </div>
          <div class="row">
            <label class="column" style="flex:1;">Bio / Guidance
              <textarea id="charBio" placeholder="Backstory, behavior boundaries, and intent."></textarea>
            </label>
          </div>
          <div class="row">
            <button id="saveCharacterBtn">Save Character</button>
          </div>
        </div>
        <div>
          <h3>Characters for Selected Model</h3>
          <ul id="characterList"></ul>
        </div>
      </div>
    </section>

    <section class="card">
      <h2>MCP Role Context</h2>
      <p class="muted">Your MCP bridge can fetch this JSON from <code>/api/mcp/context</code> before creating commands.</p>
      <pre id="mcpContext"></pre>
    </section>

    <section class="card">
      <h2>Model Capability Inspector</h2>
      <p class="muted">Check whether a model is ready for walk/gesture/skill control.</p>
      <div class="row">
        <label class="column">Model
          <select id="inspectModelSelect"></select>
        </label>
        <button id="inspectModelBtn" class="ghost">Inspect Model</button>
      </div>
      <pre id="inspectOutput">Select a model and click "Inspect Model".</pre>
    </section>

    <section class="card">
      <h2>Existing Models</h2>
      <p id="modelsDir" class="muted"></p>
      <table class="table" id="table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Type</th>
            <th>Size</th>
            <th>Updated</th>
            <th>Characters</th>
            <th>Use</th>
          </tr>
        </thead>
        <tbody></tbody>
      </table>
    </section>
  </main>
  <script>
    const fileInput = document.getElementById("file");
    const replaceFileInput = document.getElementById("replaceFileInput");
    const uploadBtn = document.getElementById("uploadBtn");
    const statusEl = document.getElementById("status");
    const modelsDirEl = document.getElementById("modelsDir");
    const tableBody = document.querySelector("#table tbody");
    const viewer = document.getElementById("viewer");
    const viewerHint = document.getElementById("viewerHint");
    const charModelSelect = document.getElementById("charModelSelect");
    const charIdInput = document.getElementById("charId");
    const actorIdInput = document.getElementById("actorId");
    const charNameInput = document.getElementById("charName");
    const charRoleInput = document.getElementById("charRole");
    const charVoiceInput = document.getElementById("charVoice");
    const charBioInput = document.getElementById("charBio");
    const saveCharacterBtn = document.getElementById("saveCharacterBtn");
    const characterList = document.getElementById("characterList");
    const mcpContextEl = document.getElementById("mcpContext");
    const inspectModelSelect = document.getElementById("inspectModelSelect");
    const inspectModelBtn = document.getElementById("inspectModelBtn");
    const inspectOutput = document.getElementById("inspectOutput");

    let modelsCache = [];
    let sceneCache = { activeModel: "", activeCharacterId: "" };
    let pendingReplaceModelName = "";

    const formatBytes = (n) => {
      if (n < 1024) return n + " B";
      if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
      return (n / (1024 * 1024)).toFixed(1) + " MB";
    };

    const setStatus = (text, isError = false) => {
      statusEl.textContent = text;
      statusEl.style.color = isError ? "#ff8b8b" : "#95a3bf";
    };

    const getModel = (name) => modelsCache.find((model) => model.name === name);
    const getCharactersForModel = (name) => {
      const model = getModel(name);
      return Array.isArray(model?.characters) ? model.characters : [];
    };

    const renderModelOptions = () => {
      const modelOptions = modelsCache.map((model) => '<option value="' + model.name + '">' + model.name + '</option>').join("");
      charModelSelect.innerHTML = modelOptions || '<option value="">No models</option>';
      inspectModelSelect.innerHTML = modelOptions || '<option value="">No models</option>';

      if (charModelSelect.value === "" && modelsCache[0]) {
        charModelSelect.value = modelsCache[0].name;
      }
      if (inspectModelSelect.value === "" && modelsCache[0]) {
        inspectModelSelect.value = modelsCache[0].name;
      }
    };

    const renderCharacterList = () => {
      const modelName = charModelSelect.value;
      const chars = getCharactersForModel(modelName);
      characterList.innerHTML = "";
      if (!chars.length) {
        characterList.innerHTML = '<li class="muted">No characters yet for this model.</li>';
        return;
      }
      chars.forEach((character) => {
        const li = document.createElement("li");
        li.innerHTML = "<strong>" + character.name + "</strong> (" + character.id + ")<br>" +
          '<span class="muted">actorId: ' + character.actorId + " | role: " + (character.role || "n/a") + "</span><br>" +
          '<span class="muted">' + (character.voiceStyle || "") + "</span><br>" +
          '<span class="muted">' + (character.bio || "") + "</span><br>" +
          '<button class="ghost" data-delete-model="' + modelName + '" data-delete-character="' + character.id + '">Delete</button>';
        characterList.appendChild(li);
      });
    };

    const renderModelTable = () => {
      tableBody.innerHTML = "";
      for (const model of modelsCache) {
        const tr = document.createElement("tr");
        const previewBtn = model.previewable
          ? '<button data-preview="' + model.url + '">Preview</button>'
          : '<span class="muted">No Web preview</span>';
        tr.innerHTML = [
          '<td><a href="' + model.url + '" target="_blank" rel="noreferrer">' + model.name + "</a></td>",
          "<td>" + model.extension + "</td>",
          "<td>" + formatBytes(model.sizeBytes) + "</td>",
          "<td>" + new Date(model.updatedAt).toLocaleString() + "</td>",
          "<td>" + (model.characters?.length || 0) + "</td>",
          '<td>' +
            previewBtn +
            ' <button class="ghost" data-focus-model="' + model.name + '">Edit Characters</button>' +
            ' <button class="ghost" data-replace-model="' + model.name + '">Replace</button>' +
            ' <button class="ghost" data-delete-model="' + model.name + '">Delete</button>' +
            ' <button class="ghost" data-inspect-model="' + model.name + '">Inspect</button>' +
            '<div class="muted">' + model.projectPath + "</div>" +
          "</td>",
        ].join("");
        tableBody.appendChild(tr);
      }
      if (!modelsCache.length) {
        const empty = document.createElement("tr");
        empty.innerHTML = '<td colspan="6" class="muted">No models yet. Upload one above.</td>';
        tableBody.appendChild(empty);
      }
    };

    const loadMcpContext = async () => {
      try {
        const response = await fetch("/api/mcp/context");
        const data = await response.json();
        mcpContextEl.textContent = JSON.stringify(data, null, 2);
      } catch (error) {
        mcpContextEl.textContent = "Failed to load /api/mcp/context: " + error.message;
      }
    };

    const loadModels = async () => {
      const response = await fetch("/api/models");
      const data = await response.json();
      modelsDirEl.textContent = "Storage: " + data.modelsDir;
      modelsCache = Array.isArray(data.models) ? data.models : [];
      sceneCache = data.scene || { activeModel: "", activeCharacterId: "" };
      renderModelOptions();
      renderCharacterList();
      renderModelTable();
      loadMcpContext();
    };

    tableBody.addEventListener("click", (event) => {
      const btn = event.target.closest("button[data-preview]");
      if (btn) {
        const url = btn.getAttribute("data-preview");
        viewer.src = url;
        viewerHint.textContent = "Previewing: " + url;
      }
      const focusBtn = event.target.closest("button[data-focus-model]");
      if (focusBtn) {
        const modelName = focusBtn.getAttribute("data-focus-model");
        charModelSelect.value = modelName;
        renderCharacterList();
        setStatus("Editing characters for " + modelName);
      }
      const inspectBtn = event.target.closest("button[data-inspect-model]");
      if (inspectBtn) {
        const modelName = inspectBtn.getAttribute("data-inspect-model");
        inspectModelSelect.value = modelName;
        inspectSelectedModel();
      }
      const replaceBtn = event.target.closest("button[data-replace-model]");
      if (replaceBtn) {
        pendingReplaceModelName = replaceBtn.getAttribute("data-replace-model");
        replaceFileInput.value = "";
        replaceFileInput.click();
      }
      const deleteBtn = event.target.closest("button[data-delete-model]");
      if (deleteBtn) {
        const modelName = deleteBtn.getAttribute("data-delete-model");
        deleteModel(modelName);
      }
    });

    const inspectSelectedModel = async () => {
      const modelName = inspectModelSelect.value;
      if (!modelName) {
        inspectOutput.textContent = "No model selected.";
        return;
      }
      if (typeof window.inspectModelCapabilities !== "function") {
        inspectOutput.textContent = "Inspector engine not ready. Refresh page and try again.";
        return;
      }
      inspectOutput.textContent = "Inspecting " + modelName + "...";
      try {
        const report = await window.inspectModelCapabilities(modelName);
        inspectOutput.textContent = JSON.stringify(report, null, 2);
      } catch (error) {
        inspectOutput.textContent = "Inspection failed: " + (error?.message || "unknown error");
      }
    };

    characterList.addEventListener("click", async (event) => {
      const btn = event.target.closest("button[data-delete-character]");
      if (!btn) return;
      const modelName = btn.getAttribute("data-delete-model");
      const characterId = btn.getAttribute("data-delete-character");
      try {
        const response = await fetch(
          "/api/models/" + encodeURIComponent(modelName) + "/characters/" + encodeURIComponent(characterId),
          { method: "DELETE" },
        );
        const payload = await response.json();
        if (!response.ok) {
          setStatus(payload.error || "Failed to delete character.", true);
          return;
        }
        setStatus("Deleted character " + characterId);
        await loadModels();
      } catch (error) {
        setStatus("Delete failed: " + (error?.message || "unknown error"), true);
      }
    });

    uploadBtn.addEventListener("click", async () => {
      const file = fileInput.files?.[0];
      if (!file) {
        setStatus("Choose a model file first.", true);
        return;
      }
      uploadBtn.disabled = true;
      setStatus("Uploading...");
      try {
        const response = await fetch("/api/models/upload", {
          method: "POST",
          headers: {
            "Content-Type": "application/octet-stream",
            "x-filename": file.name,
          },
          body: file,
        });
        const payload = await response.json();
        if (!response.ok) {
          setStatus(payload.error || "Upload failed.", true);
          return;
        }
        setStatus("Uploaded: " + payload.uploaded.name);
        fileInput.value = "";
        await loadModels();
      } catch (error) {
        setStatus("Upload failed: " + (error?.message || "unknown error"), true);
      } finally {
        uploadBtn.disabled = false;
      }
    });

    replaceFileInput.addEventListener("change", async () => {
      const modelName = pendingReplaceModelName;
      const file = replaceFileInput.files?.[0];
      pendingReplaceModelName = "";
      if (!modelName || !file) {
        return;
      }
      setStatus("Replacing " + modelName + " ...");
      try {
        const response = await fetch("/api/models/" + encodeURIComponent(modelName) + "/replace", {
          method: "PUT",
          headers: {
            "Content-Type": "application/octet-stream",
            "x-filename": file.name,
          },
          body: file,
        });
        const payload = await response.json();
        if (!response.ok) {
          setStatus(payload.error || "Replace failed.", true);
          return;
        }
        setStatus("Replaced model: " + payload.replaced.name);
        await loadModels();
      } catch (error) {
        setStatus("Replace failed: " + (error?.message || "unknown error"), true);
      }
    });

    const deleteModel = async (modelName) => {
      if (!modelName) return;
      const ok = window.confirm("Delete model '" + modelName + "'? This also removes its characters and clears active scene if selected.");
      if (!ok) return;
      setStatus("Deleting " + modelName + " ...");
      try {
        const response = await fetch("/api/models/" + encodeURIComponent(modelName), { method: "DELETE" });
        const payload = await response.json();
        if (!response.ok) {
          setStatus(payload.error || "Delete failed.", true);
          return;
        }
        setStatus("Deleted model: " + modelName);
        await loadModels();
      } catch (error) {
        setStatus("Delete failed: " + (error?.message || "unknown error"), true);
      }
    };

    saveCharacterBtn.addEventListener("click", async () => {
      const modelName = charModelSelect.value;
      if (!modelName) {
        setStatus("Select a model first.", true);
        return;
      }
      const payload = {
        id: charIdInput.value,
        actorId: actorIdInput.value,
        name: charNameInput.value,
        role: charRoleInput.value,
        voiceStyle: charVoiceInput.value,
        bio: charBioInput.value,
      };
      try {
        const response = await fetch("/api/models/" + encodeURIComponent(modelName) + "/characters", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const saved = await response.json();
        if (!response.ok) {
          setStatus(saved.error || "Failed to save character.", true);
          return;
        }
        setStatus("Saved character " + saved.saved.id + " for " + modelName);
        await loadModels();
      } catch (error) {
        setStatus("Save character failed: " + (error?.message || "unknown error"), true);
      }
    });

    charModelSelect.addEventListener("change", renderCharacterList);

    inspectModelBtn.addEventListener("click", inspectSelectedModel);

    loadModels().catch((error) => setStatus("Failed to load models: " + error.message, true));
  </script>
  <script type="importmap">
    {
      "imports": {
        "three": "https://cdn.jsdelivr.net/npm/three@0.166.1/build/three.module.js"
      }
    }
  </script>
  <script type="module">
    import * as THREE from "three";
    import { GLTFLoader } from "https://cdn.jsdelivr.net/npm/three@0.166.1/examples/jsm/loaders/GLTFLoader.js";

    const loader = new GLTFLoader();

    const hasHumanoidBones = (bones) => {
      const names = bones.map((name) => name.toLowerCase());
      const needs = ["hip", "spine", "head"];
      const hasCore = needs.every((needle) => names.some((name) => name.includes(needle)));
      const hasArm = names.some((name) => name.includes("arm")) || names.some((name) => name.includes("shoulder"));
      const hasLeg = names.some((name) => name.includes("leg")) || names.some((name) => name.includes("thigh"));
      return hasCore && hasArm && hasLeg;
    };

    const ACTION_SPEC = {
      normal_actions: {
        "idle loop": ["idle"],
        "sprint loop": ["sprint"],
        "walk loop": ["walk"],
      },
      take_damages: {
        "hit chest": ["hit chest", "hit_chest", "chest hit"],
        "hit knockback rm": ["hit knockback rm", "knockback rm", "hit knockback", "knockback"],
      },
      attacks: {
        "fighting right jab": ["fighting right jab", "right jab", "jab right"],
        "fighting left jab": ["fighting left jab", "left jab", "jab left"],
        defend: ["defend", "block", "guard"],
      },
      reactions: {
        dizzy: ["dizzy", "stun", "stunned"],
      },
      jumping: {
        "jump start": ["jump start", "jump_start", "jumpstart"],
        "jump land": ["jump land", "jump_land", "jumpland", "land"],
      },
      dancing: {
        "jumping jacks": ["jumping jacks", "jumping_jacks", "jumpingjacks"],
        "dance loop": ["dance loop", "dance_loop", "dance"],
        backflip: ["backflip", "back flip"],
      },
      additionals: {
        meditate: ["meditate", "meditation"],
      },
    };

    const classifyAnimations = (clips) => {
      const names = clips.map((clip) => clip.name || "");
      const lowerNames = names.map((name) => name.toLowerCase());
      const coverage = {};
      const matchedByAction = {};

      for (const [groupName, group] of Object.entries(ACTION_SPEC)) {
        coverage[groupName] = {};
        for (const [actionName, keywords] of Object.entries(group)) {
          const matches = names.filter((_, i) =>
            keywords.some((keyword) => lowerNames[i].includes(keyword.toLowerCase())),
          );
          coverage[groupName][actionName] = matches.length > 0;
          matchedByAction[actionName] = matches;
        }
      }

      return {
        names,
        coverage,
        matchedByAction,
      };
    };

    window.inspectModelCapabilities = async (modelName) => {
      if (!modelName || (!modelName.toLowerCase().endsWith(".glb") && !modelName.toLowerCase().endsWith(".gltf"))) {
        return {
          model: modelName,
          inspectable: false,
          reason: "Inspector currently supports .glb/.gltf models.",
          readyForAiControl: false,
        };
      }

      const url = "/assets/models/" + encodeURIComponent(modelName);
      const gltf = await new Promise((resolve, reject) => {
        loader.load(url, resolve, undefined, reject);
      });
      const scene = gltf.scene;

      let meshCount = 0;
      let skinnedMeshCount = 0;
      const bones = new Set();
      scene.traverse((node) => {
        if (node.isMesh) {
          meshCount += 1;
        }
        if (node.isSkinnedMesh) {
          skinnedMeshCount += 1;
        }
        if (node.isBone) {
          bones.add(node.name || "unnamed-bone");
        }
      });

      const boneList = Array.from(bones);
      const animSummary = classifyAnimations(gltf.animations || []);
      const humanoid = hasHumanoidBones(boneList);
      const readyWalk = skinnedMeshCount > 0
        && animSummary.coverage.normal_actions["idle loop"]
        && animSummary.coverage.normal_actions["walk loop"]
        && animSummary.coverage.normal_actions["sprint loop"];
      const readyGesture = skinnedMeshCount > 0
        && animSummary.coverage.attacks.defend
        && animSummary.coverage.reactions.dizzy;
      const readyFire = skinnedMeshCount > 0
        && animSummary.coverage.attacks["fighting right jab"]
        && animSummary.coverage.attacks["fighting left jab"];

      const checks = {
        hasMeshes: meshCount > 0,
        hasRig: skinnedMeshCount > 0,
        humanoidBonePattern: humanoid,
        actionCoverage: animSummary.coverage,
      };

      const recommendations = [];
      if (!checks.hasRig) recommendations.push("Add armature/skin for character-like control.");
      for (const [groupName, group] of Object.entries(animSummary.coverage)) {
        for (const [actionName, covered] of Object.entries(group)) {
          if (!covered) {
            recommendations.push("Missing clip for '" + actionName + "' in group '" + groupName + "'.");
          }
        }
      }

      return {
        model: modelName,
        inspectable: true,
        stats: {
          meshCount,
          skinnedMeshCount,
          boneCount: boneList.length,
          animationClipCount: animSummary.names.length,
          animationNames: animSummary.names,
        },
        checks,
        matchedClipsByAction: animSummary.matchedByAction,
        requiredActionSet: ACTION_SPEC,
        capabilityScore: {
          moveHumanLike: readyWalk,
          liftHandsOrGesture: readyGesture,
          shootFireOrCast: readyFire,
        },
        readyForAiControl: readyWalk,
        recommendations,
      };
    };
  </script>
</body>
</html>`);
});

app.get("/ui/runtime", (_, res) => {
  res.type("html").send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>ChaosLab Runtime Preview</title>
  <style>
    body { margin: 0; font-family: "Avenir Next", "Segoe UI", sans-serif; background: radial-gradient(circle at 12% 10%, #1f3454 0%, #091224 45%, #050a15 100%); color: #e5eeff; }
    main { max-width: 1200px; margin: 0 auto; padding: 20px; }
    h1 { margin: 0 0 8px; }
    p { color: #9cadc9; }
    .card { background: rgba(14, 24, 40, 0.84); border: 1px solid #28456f; border-radius: 12px; padding: 14px; margin-top: 14px; box-shadow: 0 18px 32px rgba(0,0,0,0.3); }
    .row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
    button { background: #9fe870; color: #07120a; border: none; border-radius: 10px; padding: 10px 12px; font-weight: 700; cursor: pointer; }
    button.secondary { background: #314160; color: #e5eeff; }
    button.accent { background: #62d8ff; color: #062035; }
    .muted { color: #9cadc9; font-size: 13px; }
    #sceneWrap { position: relative; width: 100%; height: min(68vh, 720px); min-height: 420px; border-radius: 12px; overflow: hidden; background: linear-gradient(180deg, #1a2f4a, #091224); border: 1px solid #2c4d79; }
    #world3d { width: 100%; height: 100%; display: block; }
    #labelLayer { position: absolute; inset: 0; pointer-events: none; }
    .actorLabel {
      position: absolute;
      transform: translate(-50%, -100%);
      background: rgba(0, 0, 0, 0.58);
      border: 1px solid rgba(148, 213, 255, 0.45);
      color: #e8f4ff;
      border-radius: 8px;
      padding: 4px 8px;
      font-size: 12px;
      white-space: nowrap;
      backdrop-filter: blur(2px);
    }
    .chatBubble {
      position: absolute;
      transform: translate(-50%, -100%);
      background: rgba(255, 254, 228, 0.95);
      color: #12243c;
      border-radius: 8px;
      padding: 4px 8px;
      font-size: 12px;
      border: 1px solid rgba(18, 36, 60, 0.28);
      max-width: 250px;
      white-space: normal;
      overflow: hidden;
      text-overflow: ellipsis;
      overflow-wrap: break-word;
    }
    .healthHud {
      position: absolute;
      transform: translate(-50%, -140%);
      display: none;
      width: 110px;
      pointer-events: none;
    }
    .healthTrack {
      width: 100%;
      height: 8px;
      border-radius: 999px;
      background: rgba(11, 22, 38, 0.84);
      border: 1px solid rgba(175, 205, 240, 0.35);
      overflow: hidden;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.28);
    }
    .healthFill {
      width: 100%;
      height: 100%;
      background: linear-gradient(90deg, #ff5f66, #ffcf5a 58%, #77ff9b);
      transform-origin: left center;
    }
    .healthText {
      margin-top: 3px;
      text-align: center;
      color: #dff1ff;
      font-size: 10px;
      letter-spacing: 0.02em;
      text-shadow: 0 1px 2px rgba(0, 0, 0, 0.7);
    }
    .damagePopup {
      position: absolute;
      transform: translate(-50%, -100%);
      color: #ffd56c;
      font-weight: 800;
      font-size: 16px;
      text-shadow: 0 1px 2px rgba(0, 0, 0, 0.95);
      white-space: nowrap;
      will-change: transform, opacity;
      pointer-events: none;
    }
    ul { margin: 8px 0 0; padding-left: 16px; }
    code { background: #1a2b45; border-radius: 6px; padding: 1px 5px; }
    .status { min-height: 18px; color: #9dd2ff; }
  </style>
</head>
<body>
  <main>
    <h1>Runtime Preview (3D Open World)</h1>
    <p>Spawn real uploaded models, stream AI commands, and watch movement/chat with VFX in a live 3D world.</p>
    <section class="card">
      <div class="row">
        <button id="autoMove" class="secondary">Auto Move + Chat (demo)</button>
        <button id="focusActor" class="accent">Focus Active Actor</button>
        <button id="resetWorld" class="secondary">Reset Shared World</button>
      </div>
      <p id="sessionInfo" class="muted">Session: connecting...</p>
      <p id="runtimeStatus" class="status"></p>
      <p class="muted">Copilot/MCP should read <code>/api/mcp/context</code> and send <code>spawn</code>, <code>move_to</code>, <code>say</code>, <code>play_animation</code> to <code>/control</code>.</p>
    </section>
    <section class="card">
      <div id="sceneWrap">
        <canvas id="world3d"></canvas>
        <div id="labelLayer"></div>
      </div>
      <p class="muted">Glow ring + movement trail + floating labels are rendered for each actor.</p>
    </section>
    <section class="card">
      <h3>Recent Chats</h3>
      <ul id="chatList"></ul>
    </section>
  </main>
  <script type="importmap">
    {
      "imports": {
        "three": "https://cdn.jsdelivr.net/npm/three@0.166.1/build/three.module.js"
      }
    }
  </script>
  <script type="module">
    import * as THREE from "https://cdn.jsdelivr.net/npm/three@0.166.1/build/three.module.js";
    import { OrbitControls } from "https://cdn.jsdelivr.net/npm/three@0.166.1/examples/jsm/controls/OrbitControls.js";
    import { GLTFLoader } from "https://cdn.jsdelivr.net/npm/three@0.166.1/examples/jsm/loaders/GLTFLoader.js";
    import { clone as cloneSkinned } from "https://cdn.jsdelivr.net/npm/three@0.166.1/examples/jsm/utils/SkeletonUtils.js";
    window.__runtimeModuleLoaded = true;

    const autoMoveBtn = document.getElementById("autoMove");
    const focusActorBtn = document.getElementById("focusActor");
    const resetWorldBtn = document.getElementById("resetWorld");
    const sessionInfo = document.getElementById("sessionInfo");
    const runtimeStatus = document.getElementById("runtimeStatus");
    const canvas = document.getElementById("world3d");
    const sceneWrap = document.getElementById("sceneWrap");
    const labelLayer = document.getElementById("labelLayer");
    const chatList = document.getElementById("chatList");

    let sessionId = "";
    let worldState = { actors: [], chats: [] };
    let pollingTimer = null;
    let autoTimer = null;
    let activeContext = null;
    let activeCharacterRef = null;
    let combatEventCursor = 0;
    const damagePopups = [];
    const impactBursts = [];

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    const scene = new THREE.Scene();
    scene.fog = new THREE.Fog(0x0c1729, 12, 48);

    const camera = new THREE.PerspectiveCamera(56, 16 / 9, 0.1, 120);
    camera.position.set(8, 7, 8);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.set(0, 1.3, 0);
    controls.enableDamping = true;
    controls.maxPolarAngle = Math.PI * 0.48;
    controls.minDistance = 3;
    controls.maxDistance = 30;

    const hemi = new THREE.HemisphereLight(0x8fc8ff, 0x0a1120, 0.9);
    scene.add(hemi);
    const key = new THREE.DirectionalLight(0xffffff, 1.4);
    key.position.set(6, 14, 8);
    key.castShadow = false;
    scene.add(key);

    const ground = new THREE.Mesh(
      new THREE.CircleGeometry(22, 96),
      new THREE.MeshStandardMaterial({
        color: 0x0f2137,
        metalness: 0.1,
        roughness: 0.9,
        emissive: 0x072244,
        emissiveIntensity: 0.36,
      }),
    );
    ground.rotation.x = -Math.PI / 2;
    scene.add(ground);

    const grid = new THREE.GridHelper(40, 40, 0x4ca4ff, 0x1f4268);
    grid.position.y = 0.005;
    grid.material.opacity = 0.35;
    grid.material.transparent = true;
    scene.add(grid);

    const loader = new GLTFLoader();
    const modelCache = new Map();
    const actorEntities = new Map();
    const pendingActorCreates = new Map();
    const pointer = new THREE.Vector3();
    const clock = new THREE.Clock();
    let worldSyncInFlight = false;

    const setStatus = (text, isError = false) => {
      runtimeStatus.textContent = text;
      runtimeStatus.style.color = isError ? "#ff9da4" : "#9dd2ff";
    };

    const toVec3 = (pos) => {
      const x = Number(pos?.[0] || 0);
      const y = Number(pos?.[1] || 0);
      const z = Number(pos?.[2] || 0);
      return new THREE.Vector3(x, y, z);
    };

    const normalizeAngle = (angle) => {
      let next = Number(angle) || 0;
      while (next > Math.PI) next -= Math.PI * 2;
      while (next < -Math.PI) next += Math.PI * 2;
      return next;
    };

    const shortestAngleDelta = (from, to) => normalizeAngle(to - from);

    const turnToward = (current, target, maxStep) => {
      const delta = shortestAngleDelta(current, target);
      if (Math.abs(delta) <= maxStep) return normalizeAngle(target);
      return normalizeAngle(current + Math.sign(delta) * maxStep);
    };

    const fitModelToHeight = (object3d, targetHeight) => {
      const box = new THREE.Box3().setFromObject(object3d);
      const size = new THREE.Vector3();
      box.getSize(size);
      if (size.y <= 0.0001) return;
      const scale = targetHeight / size.y;
      object3d.scale.multiplyScalar(scale);
      const boxAfter = new THREE.Box3().setFromObject(object3d);
      const minY = boxAfter.min.y;
      object3d.position.y += (0.02 - minY);
    };

    const createFallbackBody = () => {
      const group = new THREE.Group();
      const body = new THREE.Mesh(
        new THREE.CapsuleGeometry(0.28, 1.0, 4, 10),
        new THREE.MeshStandardMaterial({
          color: 0x7ec8ff,
          emissive: 0x114677,
          emissiveIntensity: 0.36,
          roughness: 0.34,
          metalness: 0.24,
        }),
      );
      body.position.y = 0.8;
      group.add(body);
      return group;
    };

    const createGlowRing = () => {
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(0.45, 0.62, 28),
        new THREE.MeshBasicMaterial({
          color: 0x7de3ff,
          transparent: true,
          opacity: 0.72,
          side: THREE.DoubleSide,
        }),
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 0.03;
      return ring;
    };

    const createTrail = () => {
      const points = [];
      for (let i = 0; i < 18; i += 1) points.push(new THREE.Vector3(0, 0.04, 0));
      const geometry = new THREE.BufferGeometry().setFromPoints(points);
      const material = new THREE.LineBasicMaterial({ color: 0x8fe8ff, transparent: true, opacity: 0.52 });
      const line = new THREE.Line(geometry, material);
      line.frustumCulled = false;
      return { line, points };
    };

    const normalizeClipName = (value) => String(value || "").trim().toLowerCase();

    const clipKeywords = {
      "idle loop": ["idle"],
      "walk loop": ["walk"],
      "sprint loop": ["sprint", "run"],
      "hit chest": ["hit chest", "hit_chest", "chest"],
      "hit knockback rm": ["hit knockback rm", "knockback"],
      "fighting right jab": ["right jab", "jab right"],
      "fighting left jab": ["left jab", "jab left"],
      defend: ["defend", "block", "guard"],
      dizzy: ["dizzy", "stun"],
      "jump start": ["jump start", "jump_start"],
      "jump land": ["jump land", "jump_land", "land"],
      "jumping jacks": ["jumping jacks", "jumping_jacks"],
      "dance loop": ["dance loop", "dance"],
      backflip: ["backflip", "back flip"],
      meditate: ["meditate", "meditation"],
    };

    const findBestClip = (clips, requested) => {
      if (!clips.length) return null;
      const wanted = normalizeClipName(requested);
      if (!wanted) return null;
      const exact = clips.find((clip) => normalizeClipName(clip.name) === wanted);
      if (exact) return exact;
      const keys = clipKeywords[wanted] || [wanted];
      const contains = clips.find((clip) => {
        const n = normalizeClipName(clip.name);
        return keys.some((k) => n.includes(k));
      });
      return contains || null;
    };

    const loadModelObject = async (modelName) => {
      if (!modelName) {
        return { scene: createFallbackBody(), animations: [] };
      }
      const url = "/assets/models/" + encodeURIComponent(modelName);
      const ext = modelName.split(".").pop()?.toLowerCase() || "";
      if (ext !== "glb" && ext !== "gltf") {
        return { scene: createFallbackBody(), animations: [] };
      }
      if (!modelCache.has(modelName)) {
        modelCache.set(
          modelName,
          new Promise((resolve) => {
            loader.load(
              url,
              (gltf) => resolve({
                scene: gltf.scene || createFallbackBody(),
                animations: Array.isArray(gltf.animations) ? gltf.animations : [],
              }),
              undefined,
              () => resolve({ scene: createFallbackBody(), animations: [] }),
            );
          }),
        );
      }
      const src = await modelCache.get(modelName);
      const clonedScene = cloneSkinned(src.scene);
      return { scene: clonedScene, animations: src.animations || [] };
    };

    const createActorEntity = async (actor) => {
      const root = new THREE.Group();
      const modelAsset = await loadModelObject(actor.modelName);
      const model = modelAsset.scene;
      fitModelToHeight(model, 1.8);
      root.add(model);

      const glow = createGlowRing();
      root.add(glow);

      const trail = createTrail();
      scene.add(trail.line);
      scene.add(root);

      const label = document.createElement("div");
      label.className = "actorLabel";
      labelLayer.appendChild(label);

      const chat = document.createElement("div");
      chat.className = "chatBubble";
      chat.style.display = "none";
      labelLayer.appendChild(chat);

      const healthHud = document.createElement("div");
      healthHud.className = "healthHud";
      const healthTrack = document.createElement("div");
      healthTrack.className = "healthTrack";
      const healthFill = document.createElement("div");
      healthFill.className = "healthFill";
      healthTrack.appendChild(healthFill);
      const healthText = document.createElement("div");
      healthText.className = "healthText";
      healthText.textContent = "100 HP";
      healthHud.appendChild(healthTrack);
      healthHud.appendChild(healthText);
      labelLayer.appendChild(healthHud);

      const mixer = modelAsset.animations.length ? new THREE.AnimationMixer(model) : null;
      const clipActions = new Map();
      if (mixer) {
        for (const clip of modelAsset.animations) {
          clipActions.set(clip.name, mixer.clipAction(clip));
        }
      }

      root.position.copy(toVec3(actor.position));
      root.rotation.y = Number(actor.facingYaw || 0);
      return {
        actorId: actor.actorId,
        root,
        model,
        mixer,
        clips: modelAsset.animations || [],
        clipActions,
        currentClipName: "",
        glow,
        trail,
        label,
        chat,
        healthHud,
        healthFill,
        healthText,
        targetPosition: toVec3(actor.position),
        targetYaw: Number(actor.facingYaw || 0),
        targetSpeed: Number(actor.movementSpeed || 1),
        requestedAnimation: normalizeClipName(actor.currentAnimation || "idle loop"),
        lastChat: "",
        chatExpiresAt: 0,
        lastHealth: Math.max(0, Math.min(100, Number(actor.health ?? 100))),
        healthVisibleUntil: 0,
      };
    };

    const removeActorEntity = (entity) => {
      if (!entity) return;
      scene.remove(entity.root);
      scene.remove(entity.trail.line);
      entity.label.remove();
      entity.chat.remove();
      entity.healthHud.remove();
      if (entity.mixer) {
        entity.mixer.stopAllAction();
      }
    };

    const getOrCreateActorEntity = async (actor) => {
      const existing = actorEntities.get(actor.actorId);
      if (existing) {
        return existing;
      }
      if (pendingActorCreates.has(actor.actorId)) {
        return pendingActorCreates.get(actor.actorId);
      }
      const creation = createActorEntity(actor)
        .then((created) => {
          const already = actorEntities.get(actor.actorId);
          if (already) {
            // Another async pass already registered one; discard this duplicate.
            removeActorEntity(created);
            return already;
          }
          actorEntities.set(actor.actorId, created);
          return created;
        })
        .finally(() => {
          pendingActorCreates.delete(actor.actorId);
        });
      pendingActorCreates.set(actor.actorId, creation);
      return creation;
    };

    const updateLabel = (entity, actor) => {
      entity.label.textContent = actor.name || actor.actorId;
    };

    const updateHealthHud = (entity, actor) => {
      const currentHealth = Math.max(0, Math.min(100, Number(actor?.health ?? 100)));
      if (currentHealth < entity.lastHealth) {
        entity.healthVisibleUntil = performance.now() + 3000;
      }
      entity.lastHealth = currentHealth;
      entity.healthFill.style.transform = "scaleX(" + (currentHealth / 100).toFixed(3) + ")";
      entity.healthText.textContent = Math.round(currentHealth) + " HP";
    };

    const showChat = (entity, text) => {
      entity.chat.textContent = text;
      entity.chat.style.display = "block";
      entity.chatExpiresAt = performance.now() + 3600;
    };

    const playEntityClip = (entity, requestedName) => {
      if (!entity.mixer || !entity.clips.length) {
        return;
      }
      const nextClip = findBestClip(entity.clips, requestedName) || findBestClip(entity.clips, "idle loop");
      if (!nextClip) {
        return;
      }
      if (entity.currentClipName === nextClip.name) {
        return;
      }
      const nextAction = entity.clipActions.get(nextClip.name) || entity.mixer.clipAction(nextClip);
      entity.clipActions.set(nextClip.name, nextAction);
      nextAction.reset();
      nextAction.enabled = true;
      nextAction.setEffectiveTimeScale(1);
      nextAction.setEffectiveWeight(1);
      nextAction.fadeIn(0.2);
      nextAction.play();

      if (entity.currentClipName) {
        const prevAction = entity.clipActions.get(entity.currentClipName);
        if (prevAction) {
          prevAction.fadeOut(0.2);
        }
      }
      entity.currentClipName = nextClip.name;
    };

    const updateTrail = (entity) => {
      entity.trail.points.unshift(entity.root.position.clone().setY(0.04));
      entity.trail.points.pop();
      entity.trail.line.geometry.setFromPoints(entity.trail.points);
    };

    const projectToScreen = (worldPos) => {
      pointer.copy(worldPos);
      pointer.project(camera);
      return {
        x: (pointer.x * 0.5 + 0.5) * sceneWrap.clientWidth,
        y: (-pointer.y * 0.5 + 0.5) * sceneWrap.clientHeight,
        visible: pointer.z < 1,
      };
    };

    const getActorWorldPosition = (actorId, fallbackPosition) => {
      if (actorId && actorEntities.has(actorId)) {
        return actorEntities.get(actorId).root.position.clone();
      }
      const actors = Array.isArray(worldState.actors) ? worldState.actors : [];
      const actor = actors.find((item) => item?.actorId === actorId);
      if (actor?.position) {
        return toVec3(actor.position);
      }
      if (Array.isArray(fallbackPosition)) {
        return toVec3(fallbackPosition);
      }
      return null;
    };

    const spawnImpactBurst = (worldPos) => {
      if (!worldPos) return;
      const mesh = new THREE.Mesh(
        new THREE.SphereGeometry(0.2, 10, 10),
        new THREE.MeshBasicMaterial({
          color: 0xffc14d,
          transparent: true,
          opacity: 0.95,
        }),
      );
      mesh.position.copy(worldPos.clone().add(new THREE.Vector3(0, 1.0, 0)));
      scene.add(mesh);
      impactBursts.push({
        mesh,
        createdAt: performance.now(),
        expiresAt: performance.now() + 360,
      });
    };

    const spawnDamagePopup = (worldPos, damage) => {
      if (!worldPos || !Number.isFinite(Number(damage))) return;
      const el = document.createElement("div");
      el.className = "damagePopup";
      el.textContent = "-" + Math.max(0, Math.round(Number(damage)));
      labelLayer.appendChild(el);
      damagePopups.push({
        el,
        worldPos: worldPos.clone().add(new THREE.Vector3((Math.random() - 0.5) * 0.3, 1.9, (Math.random() - 0.5) * 0.3)),
        createdAt: performance.now(),
        expiresAt: performance.now() + 850,
      });
    };

    const processCombatEvent = (event) => {
      if (!event || typeof event !== "object") return;
      if (event.type === "attack_hit") {
        const targetPos = getActorWorldPosition(event.target, event.targetPosition);
        spawnDamagePopup(targetPos, event.damage);
        spawnImpactBurst(targetPos);
        return;
      }
      if (event.type === "collision_damage") {
        const actorIds = Array.isArray(event.actors) ? event.actors : [];
        for (const actorId of actorIds) {
          const amount = Number(event.damage?.[actorId]);
          const pos = getActorWorldPosition(actorId, event.positions?.[actorId]);
          spawnDamagePopup(pos, amount);
          spawnImpactBurst(pos);
        }
      }
    };

    const processCombatEvents = () => {
      const events = Array.isArray(worldState.combatEvents) ? worldState.combatEvents : [];
      if (events.length < combatEventCursor) {
        combatEventCursor = 0;
      }
      for (let i = combatEventCursor; i < events.length; i += 1) {
        processCombatEvent(events[i]);
      }
      combatEventCursor = events.length;
    };

    const renderChats = () => {
      chatList.innerHTML = "";
      const latest = (worldState.chats || []).slice(-8).reverse();
      if (!latest.length) {
        chatList.innerHTML = '<li class="muted">No chat messages yet.</li>';
        return;
      }
      latest.forEach((msg) => {
        const li = document.createElement("li");
        li.textContent = msg.actorId + ": " + msg.text;
        chatList.appendChild(li);
      });
    };

    const refreshActiveCharacterRef = async () => {
      try {
        const response = await fetch("/api/mcp/context");
        const data = await response.json();
        activeContext = data;
        activeCharacterRef = data?.scene?.activeCharacter || null;
      } catch {
        // Keep last known active reference if context fetch fails.
      }
    };

    const syncActors = async () => {
      const sourceActors = Array.isArray(worldState.actors) ? worldState.actors : [];

      const nextIds = new Set();
      for (const actor of sourceActors) {
        if (!actor?.actorId) continue;
        nextIds.add(actor.actorId);
        const entity = await getOrCreateActorEntity(actor);
        entity.targetPosition.copy(toVec3(actor.position));
        entity.targetPosition.y = 0;
        entity.targetYaw = Number.isFinite(Number(actor.facingYaw)) ? Number(actor.facingYaw) : entity.targetYaw;
        entity.targetSpeed = Number(actor.movementSpeed || 1);
        entity.requestedAnimation = normalizeClipName(actor.currentAnimation || "idle loop");
        playEntityClip(entity, entity.requestedAnimation);
        updateLabel(entity, actor);
        updateHealthHud(entity, actor);
        if (actor.lastChat && actor.lastChat !== entity.lastChat) {
          entity.lastChat = actor.lastChat;
          showChat(entity, actor.lastChat);
        }
      }
      for (const [actorId, entity] of actorEntities.entries()) {
        if (nextIds.has(actorId)) continue;
        removeActorEntity(entity);
        actorEntities.delete(actorId);
      }
      processCombatEvents();
      renderChats();
    };

    const resizeRenderer = () => {
      const w = Math.max(sceneWrap.clientWidth, 320);
      const h = Math.max(sceneWrap.clientHeight, 320);
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };

    const animate = () => {
      requestAnimationFrame(animate);
      const t = performance.now() * 0.001;
      const delta = Math.min(clock.getDelta(), 0.05);
      controls.update();

      for (const entity of actorEntities.values()) {
        const toTarget = entity.targetPosition.clone().sub(entity.root.position);
        toTarget.y = 0;
        const dist = toTarget.length();
        const speed = Math.max(0.2, Number(entity.targetSpeed || 1));
        const maxStep = speed * delta;
        entity.root.position.y = 0;
        if (dist > 0.0001) {
          if (maxStep >= dist) {
            entity.root.position.copy(entity.targetPosition);
            entity.root.position.y = 0;
          } else {
            entity.root.position.addScaledVector(toTarget.normalize(), maxStep);
            entity.root.position.y = 0;
          }
          const moveYaw = Math.atan2(toTarget.x, toTarget.z);
          entity.root.rotation.y = turnToward(
            Number(entity.root.rotation.y || 0),
            moveYaw,
            5.2 * delta,
          );
        } else if (Number.isFinite(Number(entity.targetYaw))) {
          entity.root.rotation.y = turnToward(
            Number(entity.root.rotation.y || 0),
            Number(entity.targetYaw || 0),
            6.4 * delta,
          );
        }
        if (entity.mixer) {
          entity.mixer.update(delta);
        }
        entity.glow.material.opacity = 0.5 + Math.sin(t * 4.2) * 0.2;
        entity.glow.scale.setScalar(1 + Math.sin(t * 3.0) * 0.05);
        updateTrail(entity);

        const p = projectToScreen(entity.root.position.clone().add(new THREE.Vector3(0, 2.0, 0)));
        if (p.visible) {
          entity.label.style.display = "block";
          entity.label.style.left = p.x + "px";
          entity.label.style.top = p.y + "px";
          if (entity.healthVisibleUntil && performance.now() <= entity.healthVisibleUntil) {
            entity.healthHud.style.display = "block";
            entity.healthHud.style.left = p.x + "px";
            entity.healthHud.style.top = (p.y - 20) + "px";
          } else {
            entity.healthHud.style.display = "none";
          }
          if (entity.chat.style.display !== "none") {
            entity.chat.style.left = p.x + "px";
            entity.chat.style.top = (p.y - 64) + "px";
          }
        } else {
          entity.label.style.display = "none";
          entity.chat.style.display = "none";
          entity.healthHud.style.display = "none";
        }
        if (entity.chatExpiresAt && performance.now() > entity.chatExpiresAt) {
          entity.chat.style.display = "none";
          entity.chatExpiresAt = 0;
        }
        if (entity.healthVisibleUntil && performance.now() > entity.healthVisibleUntil) {
          entity.healthVisibleUntil = 0;
          entity.healthHud.style.display = "none";
        }
      }

      for (let i = impactBursts.length - 1; i >= 0; i -= 1) {
        const burst = impactBursts[i];
        const life = Math.max(0, burst.expiresAt - performance.now());
        const tNorm = 1 - (life / Math.max(1, burst.expiresAt - burst.createdAt));
        burst.mesh.scale.setScalar(1 + tNorm * 2.3);
        burst.mesh.material.opacity = Math.max(0, 0.95 * (1 - tNorm));
        if (life <= 0) {
          scene.remove(burst.mesh);
          burst.mesh.geometry.dispose();
          burst.mesh.material.dispose();
          impactBursts.splice(i, 1);
        }
      }

      for (let i = damagePopups.length - 1; i >= 0; i -= 1) {
        const popup = damagePopups[i];
        const life = Math.max(0, popup.expiresAt - performance.now());
        const tNorm = 1 - (life / Math.max(1, popup.expiresAt - popup.createdAt));
        popup.worldPos.y += delta * 0.7;
        const p = projectToScreen(popup.worldPos);
        if (p.visible) {
          popup.el.style.display = "block";
          popup.el.style.left = p.x + "px";
          popup.el.style.top = p.y + "px";
          popup.el.style.opacity = String(Math.max(0, 1 - tNorm));
        } else {
          popup.el.style.display = "none";
        }
        if (life <= 0) {
          popup.el.remove();
          damagePopups.splice(i, 1);
        }
      }

      renderer.render(scene, camera);
    };

    const loadWorld = async () => {
      if (worldSyncInFlight) {
        return;
      }
      worldSyncInFlight = true;
      try {
      await refreshActiveCharacterRef();
      const url = sessionId
        ? "/api/world?sessionId=" + encodeURIComponent(sessionId)
        : "/api/world";
      const response = await fetch(url);
      const data = await response.json();
      if (!response.ok) {
        setStatus("Failed to load world: " + (data.error || "unknown"), true);
        return;
      }
      worldState = data;
      await syncActors();
      } finally {
        worldSyncInFlight = false;
      }
    };

    const startPolling = () => {
      if (pollingTimer) clearInterval(pollingTimer);
      pollingTimer = setInterval(() => {
        loadWorld().catch(() => {});
      }, 350);
    };

    const postControl = async (command) => {
      const url = sessionId
        ? "/control/" + encodeURIComponent(sessionId)
        : "/control";
      await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(command),
      });
    };

    const connectSharedSession = async () => {
      const response = await fetch("/api/session/shared");
      const data = await response.json();
      if (!response.ok) {
        sessionInfo.textContent = "Failed to start session.";
        setStatus(data.error || "Cannot start runtime session.", true);
        return false;
      }
      sessionId = data.sessionId;
      sessionInfo.textContent = "Session: " + sessionId;
      setStatus("Runtime session started.");
      startPolling();
      await loadWorld();
      return true;
    };

    autoMoveBtn.addEventListener("click", async () => {
      if (!sessionId) {
        const ok = await connectSharedSession();
        if (!ok) return;
      }
      const contextResponse = await fetch("/api/mcp/context");
      const context = await contextResponse.json();
      const actorId = context?.scene?.activeCharacter?.actorId;
      activeContext = context;
      activeCharacterRef = context?.scene?.activeCharacter || null;
      if (!actorId) {
        sessionInfo.textContent = "Set active character in /ui/models first.";
        setStatus("No active character found.", true);
        return;
      }
      if (autoTimer) {
        clearInterval(autoTimer);
        autoTimer = null;
        autoMoveBtn.textContent = "Auto Move + Chat (demo)";
        setStatus("Auto demo stopped.");
        return;
      }
      autoMoveBtn.textContent = "Stop Auto Demo";
      setStatus("Auto demo running.");
      autoTimer = setInterval(async () => {
        const x = (Math.random() * 8) - 4;
        const z = (Math.random() * 8) - 4;
        const lines = [
          "[action:dance loop] Scanning the area.",
          "[action:defend] I will guide you forward.",
          "[action:fighting right jab] Hostiles are nearby.",
          "[action:jumping jacks] Follow my position.",
          "[action:meditate] Switching route to objective.",
        ];
        const text = lines[Math.floor(Math.random() * lines.length)];
        await postControl({ type: "move_to", payload: { actorId, position: [x, 0, z] } });
        await postControl({ type: "say", payload: { actorId, text, bubbleTtlMs: 2600 } });
      }, 2200);
    });

    focusActorBtn.addEventListener("click", () => {
      const actorId = activeContext?.scene?.activeCharacter?.actorId;
      if (!actorId || !actorEntities.has(actorId)) {
        setStatus("No spawned active actor to focus.", true);
        return;
      }
      const target = actorEntities.get(actorId).root.position;
      controls.target.copy(target.clone().add(new THREE.Vector3(0, 1.2, 0)));
      camera.position.copy(target.clone().add(new THREE.Vector3(3.5, 3.2, 3.5)));
      setStatus("Camera focused on active actor.");
    });

    resetWorldBtn.addEventListener("click", async () => {
      const ok = window.confirm("Reset shared world? This clears all spawned actors and chat history.");
      if (!ok) return;
      const response = await fetch("/api/world/reset", { method: "POST" });
      const data = await response.json();
      if (!response.ok) {
        setStatus(data.error || "Reset failed.", true);
        return;
      }
      worldState = { actors: [], chats: [] };
      await syncActors();
      setStatus("Shared world reset.");
    });

    window.addEventListener("resize", resizeRenderer);
    resizeRenderer();
    animate();
    setStatus("3D world ready.");
    connectSharedSession().catch(() => {});
  </script>
  <script>
    (function () {
      let fallbackSessionId = "";
      setTimeout(function () {
        if (window.__runtimeModuleLoaded) {
          return;
        }
        const sessionInfo = document.getElementById("sessionInfo");
        const status = document.getElementById("runtimeStatus");
        status.textContent = "3D engine failed to load (CDN/module blocked). Fallback controls are active.";
        status.style.color = "#ffb870";
        const layer = document.getElementById("labelLayer");
        if (layer) {
          layer.innerHTML = '<div class="actorLabel" style="left:50%;top:52%;transform:translate(-50%,-50%);display:block;">3D renderer failed to load. Check browser console/network and disable blockers for localhost.</div>';
        }

        (async function connectFallbackSession() {
          const response = await fetch("/api/session/shared");
          const data = await response.json();
          if (!response.ok) {
            status.textContent = "Fallback start failed: " + (data.error || "unknown");
            status.style.color = "#ff9da4";
            return;
          }
          fallbackSessionId = data.sessionId;
          sessionInfo.textContent = "Session: " + fallbackSessionId;
          status.textContent = "Fallback session started.";
          status.style.color = "#9dd2ff";
        })();

      }, 1200);
    })();
  </script>
</body>
</html>`);
});

app.post("/session/start", (req, res) => {
  const deviceId = req.body?.deviceId;
  if (!deviceId) {
    return res.status(400).json({ error: "deviceId is required" });
  }
  const sessionId = newSessionId();
  const payload = createSessionRecord(sessionId, deviceId);
  res.status(201).json(payload);
});

app.post("/events", requireSession, (req, res) => {
  const { type, data } = req.body || {};
  if (!type) {
    return res.status(400).json({ error: "type is required" });
  }

  // Placeholder orchestration: mirror "chat" events into a say command.
  if (type === "chat" && typeof data?.text === "string") {
    enqueueCommand(req.sessionId, "say", {
      actorId: data.actorId || "npc-1",
      text: data.text,
      bubbleTtlMs: 3000,
    });
  }

  res.status(202).json({ accepted: true });
});

app.get("/commands", requireSession, async (req, res) => {
  const since = Number(req.query.since || 0);
  const timeoutMs = Math.min(Number(req.query.timeout || 0), 20000);

  const pull = () => {
    const items = commandQueues
      .get(req.sessionId)
      .filter((command) => command.id > since);
    return items;
  };

  let commands = pull();
  if (!commands.length && timeoutMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, timeoutMs));
    commands = pull();
  }

  res.json({
    commands,
    nextSince: commands.length ? commands[commands.length - 1].id : since,
  });
});

app.post("/ack", requireSession, (req, res) => {
  const { commandId, status = "ok", details } = req.body || {};
  if (typeof commandId !== "number") {
    return res.status(400).json({ error: "commandId must be a number" });
  }

  acknowledgements.get(req.sessionId).push({
    commandId,
    status,
    details,
    executedAt: now(),
  });

  res.status(202).json({ accepted: true });
});

app.post("/control/:sessionId", (req, res) => {
  const sessionId = resolveSessionIdInput(req.params.sessionId);
  if (!sessions.has(sessionId)) {
    return res.status(404).json({ error: "session not found" });
  }

  const { type, payload = {} } = req.body || {};
  if (!type) {
    return res.status(400).json({ error: "type is required" });
  }
  Promise.resolve()
    .then(async () => {
      const nextPayload = { ...payload };
      if (type === "move_to" || type === "say" || type === "play_animation" || type === "attack") {
        const resolvedActorId = await resolveActorIdFromPayload(sessionId, payload);
        if (resolvedActorId) {
          nextPayload.actorId = resolvedActorId;
        }
      }
      const command = enqueueCommand(sessionId, type, nextPayload);
      res.status(201).json({ command });
    })
    .catch((error) => {
      res.status(400).json({ error: error.message || "control command failed" });
    });
});

app.post("/control", (req, res) => {
  const sessionId = ensureSharedSession();
  const { type, payload = {} } = req.body || {};
  if (!type) {
    return res.status(400).json({ error: "type is required" });
  }
  Promise.resolve()
    .then(async () => {
      const nextPayload = { ...payload };
      if (type === "move_to" || type === "say" || type === "play_animation" || type === "attack") {
        const resolvedActorId = await resolveActorIdFromPayload(sessionId, payload);
        if (resolvedActorId) {
          nextPayload.actorId = resolvedActorId;
        }
      }
      const command = enqueueCommand(sessionId, type, nextPayload);
      res.status(201).json({ command, sessionId, shared: true });
    })
    .catch((error) => {
      res.status(400).json({ error: error.message || "control command failed" });
    });
});

ensureSharedSession();

app.listen(PORT, () => {
  console.log(`Orchestrator server running on http://localhost:${PORT}`);
});
