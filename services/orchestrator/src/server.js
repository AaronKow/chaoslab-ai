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
/** @type {Map<string, {actors: Map<string, {actorId: string, modelName: string, characterId?: string, name?: string, role?: string, position: [number, number, number], lastUpdatedAt: number, lastChat?: string}>, chats: Array<{actorId: string, text: string, at: number}>}>} */
const worldStates = new Map();

const newSessionId = () => crypto.randomUUID();
const now = () => Date.now();

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
  const sessionId = req.header("x-session-id") || req.body?.sessionId || req.query?.sessionId;
  if (!sessionId || !sessions.has(sessionId)) {
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

function enqueueCommand(sessionId, type, payload) {
  const session = sessions.get(sessionId);
  session.cursor += 1;
  const nextCommand = {
    id: session.cursor,
    type,
    payload,
    createdAt: now(),
  };
  commandQueues.get(sessionId).push(nextCommand);
  applyCommandToWorld(sessionId, type, payload);
  return nextCommand;
}

function ensureWorldState(sessionId) {
  if (!worldStates.has(sessionId)) {
    worldStates.set(sessionId, {
      actors: new Map(),
      chats: [],
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

function applyCommandToWorld(sessionId, type, payload) {
  const world = ensureWorldState(sessionId);
  const actorId = toSafeText(payload?.actorId);
  if (!actorId) {
    return;
  }
  const currentActor = world.actors.get(actorId);

  if (type === "spawn") {
    world.actors.set(actorId, {
      actorId,
      modelName: toSafeText(payload?.modelName, currentActor?.modelName || ""),
      characterId: toSafeText(payload?.characterId, currentActor?.characterId || ""),
      name: toSafeText(payload?.name, currentActor?.name || actorId),
      role: toSafeText(payload?.role, currentActor?.role || ""),
      position: normalizePosition(payload?.position),
      lastUpdatedAt: now(),
      lastChat: currentActor?.lastChat || "",
    });
    return;
  }

  if (type === "move_to") {
    if (!currentActor) {
      return;
    }
    currentActor.position = normalizePosition(payload?.position);
    currentActor.lastUpdatedAt = now();
    world.actors.set(actorId, currentActor);
    return;
  }

  if (type === "say") {
    if (currentActor) {
      currentActor.lastChat = toSafeText(payload?.text);
      currentActor.lastUpdatedAt = now();
      world.actors.set(actorId, currentActor);
    }
    world.chats.push({
      actorId,
      text: toSafeText(payload?.text),
      at: now(),
    });
    if (world.chats.length > 50) {
      world.chats = world.chats.slice(-50);
    }
  }
}

app.get("/health", (_, res) => {
  res.json({ ok: true, sessions: sessions.size });
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
        { type: "spawn", payload: { actorId: "string", modelName: "string", characterId: "string(optional)", name: "string(optional)", role: "string(optional)", position: "[x,y,z]" } },
        { type: "say", payload: { actorId: "string", text: "string", bubbleTtlMs: "number(optional)" } },
        { type: "move_to", payload: { actorId: "string", position: "[x,y,z]", speed: "number(optional)" } },
      ],
      targetEndpoint: "POST /control/:sessionId",
      autonomyLoop: [
        "Read /api/mcp/context.",
        "Ensure active character is spawned once with type=spawn.",
        "Then continuously send move_to/say to /control/:sessionId for the same actorId.",
      ],
    });
  } catch (error) {
    res.status(500).json({ error: "Failed to build MCP context", details: error.message });
  }
});

app.get("/api/world", requireSession, (req, res) => {
  const world = ensureWorldState(req.sessionId);
  res.json({
    sessionId: req.sessionId,
    actors: Array.from(world.actors.values()),
    chats: world.chats,
    updatedAt: now(),
  });
});

app.post("/api/scene/spawn/:sessionId", async (req, res) => {
  try {
    const sessionId = req.params.sessionId;
    if (!sessions.has(sessionId)) {
      return res.status(404).json({ error: "session not found" });
    }
    const [models, registry, sceneState] = await Promise.all([
      listModels(),
      readCharacterRegistry(),
      readSceneState(),
    ]);
    const scene = createSceneSnapshot(models, registry, sceneState);
    if (!scene.activeModel || !scene.activeCharacter) {
      return res.status(400).json({ error: "No active model/character selected. Configure in /ui/models first." });
    }
    const command = enqueueCommand(sessionId, "spawn", {
      actorId: scene.activeCharacter.actorId,
      modelName: scene.activeModel,
      characterId: scene.activeCharacter.id,
      name: scene.activeCharacter.name,
      role: scene.activeCharacter.role,
      position: Array.isArray(req.body?.position) ? req.body.position : [0, 0, 0],
    });
    res.status(201).json({ command, scene });
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
      <div id="status" class="status"></div>
    </section>

    <section class="card">
      <h2>Active Scene Context</h2>
      <div class="row">
        <label class="column">Active Model
          <select id="activeModelSelect"></select>
        </label>
        <label class="column">Active Character
          <select id="activeCharacterSelect"></select>
        </label>
      </div>
      <div class="row">
        <button id="saveSceneBtn">Save Active Scene</button>
      </div>
      <p id="sceneSummary" class="muted"></p>
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
    const activeModelSelect = document.getElementById("activeModelSelect");
    const activeCharacterSelect = document.getElementById("activeCharacterSelect");
    const saveSceneBtn = document.getElementById("saveSceneBtn");
    const sceneSummary = document.getElementById("sceneSummary");
    const mcpContextEl = document.getElementById("mcpContext");

    let modelsCache = [];
    let sceneCache = { activeModel: "", activeCharacterId: "" };

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
      activeModelSelect.innerHTML = '<option value="">(none)</option>' + modelOptions;

      if (sceneCache.activeModel && getModel(sceneCache.activeModel)) {
        activeModelSelect.value = sceneCache.activeModel;
      } else if (modelsCache[0]) {
        activeModelSelect.value = modelsCache[0].name;
      }
      if (charModelSelect.value === "" && modelsCache[0]) {
        charModelSelect.value = modelsCache[0].name;
      }
    };

    const renderActiveCharacterOptions = () => {
      const modelName = activeModelSelect.value;
      const chars = getCharactersForModel(modelName);
      activeCharacterSelect.innerHTML = '<option value="">(none)</option>' + chars
        .map((character) => '<option value="' + character.id + '">' + character.name + " (" + character.id + ")</option>")
        .join("");
      if (sceneCache.activeCharacterId) {
        activeCharacterSelect.value = sceneCache.activeCharacterId;
      }
      const selectedChar = chars.find((character) => character.id === activeCharacterSelect.value);
      sceneSummary.textContent = "Active model: " + (modelName || "(none)") +
        " | Active character: " + (selectedChar ? selectedChar.name + " (" + selectedChar.id + ")" : "(none)");
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
            ' <button class="ghost" data-active-model="' + model.name + '">Set Active</button>' +
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
      renderActiveCharacterOptions();
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
      const activeBtn = event.target.closest("button[data-active-model]");
      if (activeBtn) {
        const modelName = activeBtn.getAttribute("data-active-model");
        activeModelSelect.value = modelName;
        renderActiveCharacterOptions();
        setStatus("Selected active model: " + modelName);
      }
    });

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

    activeModelSelect.addEventListener("change", () => {
      sceneCache.activeModel = activeModelSelect.value;
      sceneCache.activeCharacterId = "";
      renderActiveCharacterOptions();
    });

    charModelSelect.addEventListener("change", renderCharacterList);

    saveSceneBtn.addEventListener("click", async () => {
      const payload = {
        activeModel: activeModelSelect.value,
        activeCharacterId: activeCharacterSelect.value,
      };
      try {
        const response = await fetch("/api/scene", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const data = await response.json();
        if (!response.ok) {
          setStatus(data.error || "Failed to save active scene.", true);
          return;
        }
        sceneCache = data.scene || sceneCache;
        setStatus("Active scene saved.");
        await loadModels();
      } catch (error) {
        setStatus("Failed to save scene: " + (error?.message || "unknown error"), true);
      }
    });

    activeCharacterSelect.addEventListener("change", () => {
      sceneCache.activeCharacterId = activeCharacterSelect.value;
      renderActiveCharacterOptions();
    });

    loadModels().catch((error) => setStatus("Failed to load models: " + error.message, true));
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
    body { margin: 0; font-family: ui-sans-serif, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; background: #070b14; color: #e5eeff; }
    main { max-width: 1100px; margin: 0 auto; padding: 20px; }
    h1 { margin: 0 0 8px; }
    p { color: #9cadc9; }
    .card { background: #0f1727; border: 1px solid #233452; border-radius: 12px; padding: 14px; margin-top: 14px; }
    .row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
    button { background: #9fe870; color: #07120a; border: none; border-radius: 10px; padding: 10px 12px; font-weight: 700; cursor: pointer; }
    button.secondary { background: #314160; color: #e5eeff; }
    .muted { color: #9cadc9; font-size: 13px; }
    canvas { width: 100%; background: linear-gradient(180deg, #0f1b2f, #0a1322); border-radius: 12px; display: block; }
    ul { margin: 8px 0 0; padding-left: 16px; }
    code { background: #1a2b45; border-radius: 6px; padding: 1px 5px; }
  </style>
</head>
<body>
  <main>
    <h1>Runtime Preview (Virtual Open World)</h1>
    <p>Spawn your active model character and preview live move/chat behavior from orchestrator commands.</p>
    <section class="card">
      <div class="row">
        <button id="startSession">Start Runtime Session</button>
        <button id="spawnActive" class="secondary">Spawn Active Character</button>
        <button id="autoMove" class="secondary">Auto Move + Chat (demo)</button>
      </div>
      <p id="sessionInfo" class="muted">Session: not started</p>
      <p class="muted">Copilot/MCP should read <code>/api/mcp/context</code> and send <code>spawn</code>, <code>move_to</code>, <code>say</code> to <code>/control/:sessionId</code>.</p>
    </section>
    <section class="card">
      <canvas id="world" width="980" height="520"></canvas>
      <p class="muted">Top-down world. X/Z mapped into canvas. Circles are actors; labels and chat bubbles update live.</p>
    </section>
    <section class="card">
      <h3>Recent Chats</h3>
      <ul id="chatList"></ul>
    </section>
  </main>
  <script>
    const startSessionBtn = document.getElementById("startSession");
    const spawnActiveBtn = document.getElementById("spawnActive");
    const autoMoveBtn = document.getElementById("autoMove");
    const sessionInfo = document.getElementById("sessionInfo");
    const canvas = document.getElementById("world");
    const ctx = canvas.getContext("2d");
    const chatList = document.getElementById("chatList");

    let sessionId = "";
    let worldState = { actors: [], chats: [] };
    let pollingTimer = null;
    let autoTimer = null;

    const colorFor = (id) => {
      let hash = 0;
      for (let i = 0; i < id.length; i++) {
        hash = ((hash << 5) - hash) + id.charCodeAt(i);
        hash |= 0;
      }
      const hue = Math.abs(hash) % 360;
      return "hsl(" + hue + ", 72%, 60%)";
    };

    const worldToCanvas = (position) => {
      const x = Number(position?.[0] || 0);
      const z = Number(position?.[2] || 0);
      const scale = 55;
      return {
        x: canvas.width / 2 + x * scale,
        y: canvas.height / 2 + z * scale,
      };
    };

    const drawGrid = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.strokeStyle = "#1c2a43";
      ctx.lineWidth = 1;
      for (let x = 0; x <= canvas.width; x += 40) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, canvas.height);
        ctx.stroke();
      }
      for (let y = 0; y <= canvas.height; y += 40) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(canvas.width, y);
        ctx.stroke();
      }
      ctx.strokeStyle = "#35507a";
      ctx.beginPath();
      ctx.moveTo(canvas.width / 2, 0);
      ctx.lineTo(canvas.width / 2, canvas.height);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(0, canvas.height / 2);
      ctx.lineTo(canvas.width, canvas.height / 2);
      ctx.stroke();
    };

    const drawActors = () => {
      worldState.actors.forEach((actor) => {
        const p = worldToCanvas(actor.position);
        ctx.fillStyle = colorFor(actor.actorId);
        ctx.beginPath();
        ctx.arc(p.x, p.y, 16, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = "#e6f0ff";
        ctx.font = "12px ui-sans-serif, system-ui";
        ctx.fillText((actor.name || actor.actorId) + " [" + actor.actorId + "]", p.x + 20, p.y - 6);
        if (actor.role) {
          ctx.fillStyle = "#9cadc9";
          ctx.fillText(actor.role, p.x + 20, p.y + 11);
        }
        if (actor.lastChat) {
          ctx.fillStyle = "#f6ffb4";
          ctx.fillText('"' + actor.lastChat.slice(0, 42) + '"', p.x + 20, p.y + 28);
        }
      });
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

    const render = () => {
      drawGrid();
      drawActors();
      renderChats();
    };

    const loadWorld = async () => {
      if (!sessionId) return;
      const response = await fetch("/api/world?sessionId=" + encodeURIComponent(sessionId));
      const data = await response.json();
      if (response.ok) {
        worldState = data;
        render();
      }
    };

    const startPolling = () => {
      if (pollingTimer) clearInterval(pollingTimer);
      pollingTimer = setInterval(() => {
        loadWorld().catch(() => {});
      }, 350);
    };

    const postControl = async (command) => {
      if (!sessionId) return;
      await fetch("/control/" + encodeURIComponent(sessionId), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(command),
      });
    };

    startSessionBtn.addEventListener("click", async () => {
      const response = await fetch("/session/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deviceId: "runtime-preview" }),
      });
      const data = await response.json();
      if (!response.ok) {
        sessionInfo.textContent = "Failed to start session.";
        return;
      }
      sessionId = data.sessionId;
      sessionInfo.textContent = "Session: " + sessionId;
      startPolling();
      await loadWorld();
    });

    spawnActiveBtn.addEventListener("click", async () => {
      if (!sessionId) {
        sessionInfo.textContent = "Start session first.";
        return;
      }
      const response = await fetch("/api/scene/spawn/" + encodeURIComponent(sessionId), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ position: [0, 0, 0] }),
      });
      const data = await response.json();
      if (!response.ok) {
        sessionInfo.textContent = "Spawn failed: " + (data.error || "unknown");
        return;
      }
      sessionInfo.textContent = "Spawned active character in session " + sessionId;
      await loadWorld();
    });

    autoMoveBtn.addEventListener("click", async () => {
      if (!sessionId) {
        sessionInfo.textContent = "Start session first.";
        return;
      }
      const contextResponse = await fetch("/api/mcp/context");
      const context = await contextResponse.json();
      const actorId = context?.scene?.activeCharacter?.actorId;
      if (!actorId) {
        sessionInfo.textContent = "Set active character in /ui/models first.";
        return;
      }
      if (autoTimer) {
        clearInterval(autoTimer);
        autoTimer = null;
        autoMoveBtn.textContent = "Auto Move + Chat (demo)";
        return;
      }
      autoMoveBtn.textContent = "Stop Auto Demo";
      autoTimer = setInterval(async () => {
        const x = (Math.random() * 8) - 4;
        const z = (Math.random() * 8) - 4;
        const lines = [
          "Scanning the area.",
          "I will guide you forward.",
          "Hostiles are nearby.",
          "Follow my position.",
          "Switching route to objective.",
        ];
        const text = lines[Math.floor(Math.random() * lines.length)];
        await postControl({ type: "move_to", payload: { actorId, position: [x, 0, z], speed: 1.3 } });
        await postControl({ type: "say", payload: { actorId, text, bubbleTtlMs: 2600 } });
      }, 2200);
    });

    render();
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
  const initialTimestamp = now();
  sessions.set(sessionId, {
    deviceId,
    createdAt: initialTimestamp,
    lastSeenAt: initialTimestamp,
    cursor: 0,
  });
  commandQueues.set(sessionId, []);
  acknowledgements.set(sessionId, []);
  worldStates.set(sessionId, { actors: new Map(), chats: [] });

  res.status(201).json({
    sessionId,
    polling: {
      minMs: 300,
      maxMs: 2000,
      suggestedMs: 500,
    },
  });
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
  const { sessionId } = req.params;
  if (!sessions.has(sessionId)) {
    return res.status(404).json({ error: "session not found" });
  }

  const { type, payload = {} } = req.body || {};
  if (!type) {
    return res.status(400).json({ error: "type is required" });
  }

  const command = enqueueCommand(sessionId, type, payload);
  res.status(201).json({ command });
});

app.listen(PORT, () => {
  console.log(`Orchestrator server running on http://localhost:${PORT}`);
});
