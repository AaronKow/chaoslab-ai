import process from "node:process";

const ORCHESTRATOR_URL = process.env.ORCHESTRATOR_URL || "http://localhost:8787";
const SERVER_NAME = "chaoslab-orchestrator-mcp";
const SERVER_VERSION = "0.1.0";
const DEFAULT_PROTOCOL_VERSION = "2024-11-05";

const toolSchemas = [
  {
    name: "get_context",
    description: "Get current active model/character context and command schema from orchestrator.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
  },
  {
    name: "get_shared_session",
    description: "Get the shared session id used by default by all tools when sessionId is omitted.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
  },
  {
    name: "spawn_avatar",
    description: "Spawn a specific avatar (character id or name). Recommended tool for AI control.",
    inputSchema: {
      type: "object",
      required: ["character"],
      additionalProperties: false,
      properties: {
        sessionId: { type: "string", description: "Optional. Defaults to shared session." },
        character: {
          type: "string",
          description: "Character id or character name, e.g. dora-rock",
        },
        position: {
          type: "array",
          minItems: 3,
          maxItems: 3,
          items: { type: "number" },
        },
      },
    },
  },
  {
    name: "send_command",
    description: "Send a control command. If sessionId is omitted, uses shared session.",
    inputSchema: {
      type: "object",
      required: ["type", "payload"],
      additionalProperties: false,
      properties: {
        sessionId: { type: "string", description: "Optional. Defaults to shared session." },
        type: { type: "string", description: "spawn | move_to | say | other custom command type" },
        payload: { type: "object" },
      },
    },
  },
  {
    name: "get_world",
    description: "Read current actor/chats world state. If sessionId is omitted, uses shared session.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        sessionId: { type: "string", description: "Optional. Defaults to shared session." },
      },
    },
  },
  {
    name: "list_models",
    description: "List models and character registry data from orchestrator.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
  },
];

function sendMessage(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function sendResult(id, result) {
  sendMessage({ jsonrpc: "2.0", id, result });
}

function sendError(id, code, message, data) {
  sendMessage({
    jsonrpc: "2.0",
    id,
    error: {
      code,
      message,
      data,
    },
  });
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function orchestratorRequest(path, options = {}) {
  const response = await fetch(`${ORCHESTRATOR_URL}${path}`, options);
  const raw = await response.text();
  let body;
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch {
    body = { raw };
  }
  return { ok: response.ok, status: response.status, body };
}

function asTextResult(body) {
  const text = typeof body === "string" ? body : JSON.stringify(body, null, 2);
  return {
    content: [{ type: "text", text }],
    structuredContent: body,
  };
}

function requireString(name, value) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value.trim();
}

function optionalString(value) {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim();
}

function normalizeText(value) {
  return String(value || "").trim().toLowerCase();
}

function pickCharacterFromModels(modelsPayload, query) {
  const models = Array.isArray(modelsPayload?.models) ? modelsPayload.models : [];
  const wanted = normalizeText(query);
  if (!wanted) {
    return null;
  }

  // First pass: exact match on id, actorId, or name.
  for (const model of models) {
    const chars = Array.isArray(model?.characters) ? model.characters : [];
    for (const character of chars) {
      const id = normalizeText(character?.id);
      const actorId = normalizeText(character?.actorId);
      const name = normalizeText(character?.name);
      if (wanted === id || wanted === actorId || wanted === name) {
        return { model, character };
      }
    }
  }

  // Second pass: contains.
  for (const model of models) {
    const chars = Array.isArray(model?.characters) ? model.characters : [];
    for (const character of chars) {
      const id = normalizeText(character?.id);
      const actorId = normalizeText(character?.actorId);
      const name = normalizeText(character?.name);
      if (id.includes(wanted) || actorId.includes(wanted) || name.includes(wanted)) {
        return { model, character };
      }
    }
  }

  return null;
}

async function resolveSessionId(optionalSessionId) {
  const explicit = optionalString(optionalSessionId);
  if (explicit) {
    return { sessionId: explicit, shared: false };
  }
  const response = await orchestratorRequest("/api/session/shared");
  if (!response.ok || typeof response.body?.sessionId !== "string") {
    throw new Error(`Failed to get shared session: ${response.status}`);
  }
  return { sessionId: response.body.sessionId, shared: true };
}

async function handleToolCall(name, args) {
  if (!isObject(args)) {
    throw new Error("Tool arguments must be an object");
  }
  if (name === "get_context") {
    const response = await orchestratorRequest("/api/mcp/context");
    return asTextResult(response.body);
  }
  if (name === "start_session") {
    const response = await orchestratorRequest("/api/session/shared");
    return asTextResult({
      ...response.body,
      note: "start_session is mapped to shared session to prevent runtime mismatch.",
    });
  }
  if (name === "get_shared_session") {
    const response = await orchestratorRequest("/api/session/shared");
    return asTextResult(response.body);
  }
  if (name === "spawn_active") {
    const resolved = await resolveSessionId(args.sessionId);
    const sessionId = resolved.sessionId;
    const response = await orchestratorRequest(`/api/scene/spawn/${encodeURIComponent(sessionId)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        position: Array.isArray(args.position) ? args.position : [0, 0, 0],
      }),
    });
    return asTextResult({ ...response.body, sessionId, sharedSessionFallback: resolved.shared });
  }
  if (name === "spawn_avatar") {
    const resolved = await resolveSessionId(args.sessionId);
    const sessionId = resolved.sessionId;
    const characterQuery = requireString("character", args.character);

    const modelsResponse = await orchestratorRequest("/api/models");
    if (!modelsResponse.ok) {
      throw new Error(`Failed to list models/characters: ${modelsResponse.status}`);
    }
    const picked = pickCharacterFromModels(modelsResponse.body, characterQuery);
    if (!picked) {
      throw new Error(`Character not found: ${characterQuery}`);
    }

    const response = await orchestratorRequest(`/control/${encodeURIComponent(sessionId)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "spawn",
        payload: {
          actorId: picked.character.actorId || picked.character.id,
          modelName: picked.model.name,
          characterId: picked.character.id || "",
          name: picked.character.name || picked.character.id || "Character",
          role: picked.character.role || "",
          position: Array.isArray(args.position) ? args.position : [0, 0, 0],
        },
      }),
    });
    return asTextResult({
      ...response.body,
      sessionId,
      sharedSessionFallback: resolved.shared,
      selectedCharacter: {
        query: characterQuery,
        matchedModel: picked.model.name,
        matchedCharacter: picked.character,
      },
    });
  }
  if (name === "send_command") {
    const resolved = await resolveSessionId(args.sessionId);
    const sessionId = resolved.sessionId;
    const type = requireString("type", args.type);
    const payload = isObject(args.payload) ? args.payload : {};
    const response = await orchestratorRequest(`/control/${encodeURIComponent(sessionId)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type, payload }),
    });
    return asTextResult({ ...response.body, sessionId, sharedSessionFallback: resolved.shared });
  }
  if (name === "get_world") {
    const resolved = await resolveSessionId(args.sessionId);
    const sessionId = resolved.sessionId;
    const response = await orchestratorRequest(`/api/world?sessionId=${encodeURIComponent(sessionId)}`);
    return asTextResult({ ...response.body, sessionId, sharedSessionFallback: resolved.shared });
  }
  if (name === "list_models") {
    const response = await orchestratorRequest("/api/models");
    return asTextResult(response.body);
  }
  throw new Error(`Unknown tool: ${name}`);
}

async function handleRequest(message) {
  const { id, method, params } = message;

  if (method === "initialize") {
    const requestedProtocolVersion =
      typeof params?.protocolVersion === "string" && params.protocolVersion.trim()
        ? params.protocolVersion.trim()
        : DEFAULT_PROTOCOL_VERSION;
    sendResult(id, {
      protocolVersion: requestedProtocolVersion,
      capabilities: {
        tools: {
          listChanged: false,
        },
      },
      serverInfo: {
        name: SERVER_NAME,
        version: SERVER_VERSION,
      },
    });
    return;
  }

  if (method === "tools/list") {
    sendResult(id, {
      tools: toolSchemas,
    });
    return;
  }

  if (method === "tools/call") {
    try {
      const name = params?.name;
      const args = params?.arguments || {};
      const result = await handleToolCall(name, args);
      sendResult(id, result);
    } catch (error) {
      sendResult(id, {
        content: [
          {
            type: "text",
            text: `Tool call failed: ${error.message}`,
          },
        ],
        isError: true,
      });
    }
    return;
  }

  if (method === "ping") {
    sendResult(id, {});
    return;
  }

  if (method === "notifications/initialized") {
    return;
  }

  if (id !== undefined) {
    sendError(id, -32601, `Method not found: ${method}`);
  }
}

async function handleMessage(message) {
  if (!isObject(message)) {
    return;
  }
  if (message.jsonrpc !== "2.0") {
    if (message.id !== undefined) {
      sendError(message.id, -32600, "Invalid JSON-RPC version");
    }
    return;
  }
  if (typeof message.method === "string") {
    await handleRequest(message);
  }
}

let lineBuffer = "";

async function processLines() {
  while (true) {
    const newlineIndex = lineBuffer.indexOf("\n");
    if (newlineIndex === -1) {
      return;
    }
    const rawLine = lineBuffer.slice(0, newlineIndex);
    lineBuffer = lineBuffer.slice(newlineIndex + 1);
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        // Keep lifecycle ordering stable even in batches.
        await handleMessage(item);
      }
      continue;
    }
    await handleMessage(parsed);
  }
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", async (chunk) => {
  lineBuffer += chunk;
  try {
    await processLines();
  } catch (error) {
    console.error(`[${SERVER_NAME}]`, error);
  }
});

process.stdin.on("error", (error) => {
  console.error(`[${SERVER_NAME}] stdin error`, error);
});

process.on("uncaughtException", (error) => {
  console.error(`[${SERVER_NAME}] uncaughtException`, error);
});

process.on("unhandledRejection", (error) => {
  console.error(`[${SERVER_NAME}] unhandledRejection`, error);
});
