import express from "express";
import crypto from "node:crypto";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8787;
const SESSION_TTL_MS = 1000 * 60 * 30;

/** @type {Map<string, {deviceId: string, createdAt: number, lastSeenAt: number, cursor: number}>} */
const sessions = new Map();
/** @type {Map<string, Array<{id: number, type: string, payload: Record<string, unknown>, createdAt: number}>>} */
const commandQueues = new Map();
/** @type {Map<string, Array<{commandId: number, executedAt: number, status: string, details?: string}>>} */
const acknowledgements = new Map();

const newSessionId = () => crypto.randomUUID();
const now = () => Date.now();

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
  return nextCommand;
}

app.get("/health", (_, res) => {
  res.json({ ok: true, sessions: sessions.size });
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
