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
    name: "start_session",
    description: "Create a new orchestrator session for runtime/mobile clients.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        deviceId: { type: "string", description: "Optional logical device id." },
      },
    },
  },
  {
    name: "spawn_active",
    description: "Spawn active model+character for a given session.",
    inputSchema: {
      type: "object",
      required: ["sessionId"],
      additionalProperties: false,
      properties: {
        sessionId: { type: "string" },
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
    description: "Send a control command to orchestrator for a session.",
    inputSchema: {
      type: "object",
      required: ["sessionId", "type", "payload"],
      additionalProperties: false,
      properties: {
        sessionId: { type: "string" },
        type: { type: "string", description: "spawn | move_to | say | other custom command type" },
        payload: { type: "object" },
      },
    },
  },
  {
    name: "get_world",
    description: "Read current actor/chats world state for a session.",
    inputSchema: {
      type: "object",
      required: ["sessionId"],
      additionalProperties: false,
      properties: {
        sessionId: { type: "string" },
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

async function handleToolCall(name, args) {
  if (!isObject(args)) {
    throw new Error("Tool arguments must be an object");
  }
  if (name === "get_context") {
    const response = await orchestratorRequest("/api/mcp/context");
    return asTextResult(response.body);
  }
  if (name === "start_session") {
    const response = await orchestratorRequest("/session/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deviceId: typeof args.deviceId === "string" ? args.deviceId : "copilot-mcp" }),
    });
    return asTextResult(response.body);
  }
  if (name === "spawn_active") {
    const sessionId = requireString("sessionId", args.sessionId);
    const response = await orchestratorRequest(`/api/scene/spawn/${encodeURIComponent(sessionId)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        position: Array.isArray(args.position) ? args.position : [0, 0, 0],
      }),
    });
    return asTextResult(response.body);
  }
  if (name === "send_command") {
    const sessionId = requireString("sessionId", args.sessionId);
    const type = requireString("type", args.type);
    const payload = isObject(args.payload) ? args.payload : {};
    const response = await orchestratorRequest(`/control/${encodeURIComponent(sessionId)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type, payload }),
    });
    return asTextResult(response.body);
  }
  if (name === "get_world") {
    const sessionId = requireString("sessionId", args.sessionId);
    const response = await orchestratorRequest(`/api/world?sessionId=${encodeURIComponent(sessionId)}`);
    return asTextResult(response.body);
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
