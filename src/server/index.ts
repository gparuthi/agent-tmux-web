import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes } from "node:crypto";
import http from "node:http";
import path from "node:path";
import { promisify } from "node:util";

import express, { type Request, type Response, type NextFunction } from "express";
import { WebSocketServer, type RawData, type WebSocket } from "ws";

import {
  TMUX_CAPTURE_HISTORY_LINES,
  type AgentsDto,
  type AppStatus,
  type StartAgentResultDto,
  type TmuxCaptureDto,
  type TmuxSessionDto
} from "../shared/api.js";
import { describeCodexNotification } from "../shared/codexEvents.js";
import { classifyTmuxStatus, resolveTmuxSessionStatus } from "../shared/tmuxStatus.js";
import { listAgentDirectories, listAvailableAgents, NEW_AGENT_TMUX_SESSION, startAgentInTmux } from "./agents.js";
import { createAuthMiddleware, isAuthorizedWebSocketRequest, parseTailscaleLogins } from "./auth.js";
import { resolveAuthToken } from "./authToken.js";
import { AgentRowsCache } from "./agentRows.js";
import { ClaudePromptTimes } from "./claudePrompts.js";
import { CodexBridge } from "./codexBridge.js";
import { readTmuxPaneAgents } from "./paneAgents.js";
import {
  buildBrowserRawTerminalPolicy,
  buildTmuxCaptureSizeFromClientDimensions,
  buildScriptSpawn,
  buildTmuxGroupedAttachShellCommand,
  buildTmuxDisplayWindowSizeArgs,
  buildTmuxResizeWindowArgs,
  buildTmuxRestoreWindowStateCommandSequence,
  buildTmuxShowWindowSizeOptionArgs,
  isSameTerminalSize,
  normalizeTerminalSize,
  parseTmuxWindowSize,
  TMUX_RAW_SESSION_PREFIX,
  type TerminalSize,
  type TmuxWindowState
} from "./terminal.js";
import {
  buildTmuxPaneAgentLabel,
  captureTmuxPane,
  captureTmuxPaneView,
  captureTmuxVisiblePane,
  closeTmuxPane,
  createTmuxSession,
  detectTmuxInterruptKey,
  detectTmuxSubmitKey,
  destroyTmuxSession,
  fitTmuxCaptureSizeForPane,
  inspectTmuxPane,
  interruptTmuxPane,
  killTmuxSessionQuietly,
  listOrphanedTmuxRawSessions,
  listTmuxSessions,
  listTmuxTools,
  openCodexInTmux,
  openTmuxTool,
  readTmuxHarnessStatuses,
  readTmuxViewerCounts,
  resolveClosableTmuxPane,
  resolveTmuxPaneEntry,
  resolveTmuxSessionName,
  sendTmuxKey,
  sendTmuxText,
  splitTmuxPaneTarget,
  type TmuxInterruptKey,
  type TmuxSubmitKey
} from "./tmux.js";
import {
  cleanupUploadRoots,
  resolveLegacyUploadRoot,
  resolveUploadAliasRoot,
  resolveUploadRoot,
  saveUploadedFileForClient
} from "./uploads.js";
import { DEFAULT_TMUX_LAST_INPUT_FILE, latestTmuxInputAtMs, readTmuxClientActivity, TmuxLastInputStore } from "./tmuxLastInput.js";
import { TmuxWatchStore } from "./tmuxWatch.js";

const execFileAsync = promisify(execFile);

const bindHost = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? 6174);
const codexAppServerPort = Number(process.env.CODEX_APP_SERVER_PORT ?? 43117);
const codexAppServerAutostart = process.env.CODEX_APP_SERVER_AUTOSTART === "1";
const authToken = resolveAuthToken(process.env);
const tailscaleLogins = parseTailscaleLogins(process.env.ATW_TAILSCALE_LOGINS);
const defaultCwd = process.env.CLI_WEB_DEFAULT_CWD ?? process.env.HOME ?? process.cwd();
const jsonBodyLimit = process.env.AGENT_TMUX_WEB_JSON_LIMIT ?? "25mb";
const runtimeEnvironment = process.env.AGENT_TMUX_WEB_ENV === "development"
  ? "development"
  : "production";
const developmentMode = runtimeEnvironment === "development";

const app = express();
const server = http.createServer(app);
const bridge = new CodexBridge({ port: codexAppServerPort });
const sockets = new Set<WebSocket>();
const rawTerminalClients = new Map<string, Map<string, number>>();
// Grouped raw sessions by routed target, with the base session they join and a cleanup hook.
const rawTerminalSessions = new Map<string, { baseSession: string; close: () => void }>();
const claudePromptTimes = new ClaudePromptTimes();
const agentRowsCache = new AgentRowsCache();
const tmuxLastInput = new TmuxLastInputStore(process.env.AGENT_TMUX_WEB_LAST_INPUT_FILE || DEFAULT_TMUX_LAST_INPUT_FILE);
const recentEvents: unknown[] = [];
const watchPollers = new Map<string, {
  id: string;
  lastSeen: string;
  remoteAddress: string;
  since: number;
  userAgent: string;
}>();
const tmuxWatch = new TmuxWatchStore({
  capture: captureTmuxPane,
  listSessions: listTmuxSessions,
  onEvent: (event) => broadcast({ type: "tmux-watch-done", event }),
  onError: (error, session) => {
    if ((process.env.AGENT_TMUX_WEB_VERBOSE ?? process.env.CODEX_WEB_VERBOSE) === "1") {
      console.error(`tmux watch failed for ${session}`, error);
    }
  }
});
const jsonBodyParser = express.json({ limit: jsonBodyLimit });

app.disable("x-powered-by");

app.use((_req, res, next) => {
  res.setHeader("Content-Security-Policy", [
    "default-src 'self'",
    "connect-src 'self' ws: wss:",
    "img-src 'self' data: blob:",
    "style-src 'self' 'unsafe-inline'",
    `script-src 'self'${developmentMode ? " 'unsafe-inline'" : ""}`,
    `worker-src 'self'${developmentMode ? " blob:" : ""}`,
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'"
  ].join("; "));
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  next();
});

app.use((req, res, next) => {
  if (req.path === "/api/uploads") {
    next();
    return;
  }
  jsonBodyParser(req, res, next);
});

app.use(createAuthMiddleware({
  authToken,
  tailscaleLogins,
  isPublicRequest: (req) => req.path === "/healthz" || isPublicAssetRequest(req)
}));

app.get("/healthz", (_req, res) => {
  res.json({ ok: true });
});

// Lets the client confirm the auth cookie works before it drops the token from the URL.
app.get("/api/auth/session", (_req, res) => {
  res.json({ ok: true });
});

app.get("/api/status", asyncHandler(async (_req, res) => {
  res.json(await getStatus());
}));

app.get("/api/models", asyncHandler(async (_req, res) => {
  const result = await bridge.rpc("model/list", { limit: 100, includeHidden: false });
  res.json(result);
}));

app.get("/api/skills", asyncHandler(async (req, res) => {
  const cwd = typeof req.query.cwd === "string" && req.query.cwd ? req.query.cwd : process.cwd();
  const result = await bridge.rpc("skills/list", { cwds: [cwd], forceReload: req.query.reload === "1" });
  res.json(result);
}));

app.get("/api/threads", asyncHandler(async (_req, res) => {
  const result = await bridge.rpc("thread/list", {
    limit: 60,
    sourceKinds: ["cli", "exec", "appServer"],
    archived: false
  });
  res.json(result);
}));

app.get("/api/thread/:threadId", asyncHandler(async (req, res) => {
  const result = await bridge.rpc("thread/read", {
    threadId: req.params.threadId,
    includeTurns: true
  });
  res.json(result);
}));

app.post("/api/thread/start", asyncHandler(async (req, res) => {
  const body = req.body as Record<string, unknown>;
  const result = await bridge.rpc("thread/start", {
    cwd: stringOrNull(body.cwd) ?? process.env.HOME ?? process.cwd(),
    model: stringOrNull(body.model),
    serviceTier: stringOrNull(body.serviceTier) ?? "fast",
    approvalPolicy: "never",
    approvalsReviewer: "user",
    sandbox: "danger-full-access",
    threadSource: "user",
    sessionStartSource: "startup"
  });
  res.json(result);
}));

app.post("/api/thread/resume", asyncHandler(async (req, res) => {
  const body = req.body as Record<string, unknown>;
  const threadId = requireString(body.threadId, "threadId");
  const result = await bridge.rpc("thread/resume", {
    threadId,
    cwd: stringOrNull(body.cwd),
    model: stringOrNull(body.model),
    serviceTier: stringOrNull(body.serviceTier) ?? "fast",
    approvalPolicy: "never",
    approvalsReviewer: "user",
    sandbox: "danger-full-access"
  });
  res.json(result);
}));

app.post("/api/turn/start", asyncHandler(async (req, res) => {
  const body = req.body as Record<string, unknown>;
  const threadId = requireString(body.threadId, "threadId");
  const text = requireString(body.text, "text");
  const result = await bridge.rpc("turn/start", {
    threadId,
    input: buildUserInput(text, body.skills),
    cwd: stringOrNull(body.cwd),
    approvalPolicy: "never",
    sandboxPolicy: { type: "dangerFullAccess" },
    model: stringOrNull(body.model),
    serviceTier: stringOrNull(body.serviceTier) ?? "fast",
    effort: stringOrNull(body.effort)
  });
  res.json(result);
}));

app.post("/api/turn/steer", asyncHandler(async (req, res) => {
  const body = req.body as Record<string, unknown>;
  const result = await bridge.rpc("turn/steer", {
    threadId: requireString(body.threadId, "threadId"),
    expectedTurnId: requireString(body.expectedTurnId, "expectedTurnId"),
    input: buildUserInput(requireString(body.text, "text"), body.skills)
  });
  res.json(result);
}));

app.post("/api/turn/interrupt", asyncHandler(async (req, res) => {
  const body = req.body as Record<string, unknown>;
  const result = await bridge.rpc("turn/interrupt", {
    threadId: requireString(body.threadId, "threadId")
  });
  res.json(result);
}));

app.get("/api/tmux/sessions", asyncHandler(async (req, res) => {
  res.json({ data: await listTmuxSessionsWithStatus(stringOrNull(req.query.clientId)) });
}));

app.get("/api/tmux/tools", asyncHandler(async (_req, res) => {
  res.json({ data: listTmuxTools() });
}));

app.get("/api/tmux/capture", asyncHandler(async (req, res) => {
  const session = requireString(req.query.session, "session");
  const lines = typeof req.query.lines === "string" ? Number(req.query.lines) : TMUX_CAPTURE_HISTORY_LINES;
  const outputRevision = stringOrNull(req.query.outputRevision);
  if (req.query.resize === "true") {
    const [preserveExistingClientSize, paneMetadata] = await Promise.all([
      hasAttachedTmuxClients(session).catch(() => false),
      inspectTmuxPane(session).catch(() => null)
    ]);
    const captureSize = fitTmuxCaptureSizeForPane(
      buildTmuxCaptureSizeFromClientDimensions(req.query.clientWidth, req.query.clientHeight),
      paneMetadata
    );
    const resized = !preserveExistingClientSize && await resizeTmuxWindowIfNeeded(session, captureSize).catch(() => {
      // Best-effort: capture remains useful even if tmux rejects a resize.
      return false;
    });
    if (resized) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  const capture = await captureTmuxPaneView(session, lines, outputRevision ?? undefined, { ansi: req.query.ansi === "true" });
  res.json({ session, ...capture } satisfies TmuxCaptureDto);
}));

app.post("/api/tmux/create", asyncHandler(async (req, res) => {
  const body = req.body as Record<string, unknown>;
  await createTmuxSession(
    requireString(body.name, "name"),
    stringOrNull(body.cwd)
  );
  res.json({
    data: await listTmuxSessionsWithStatus()
  });
}));

app.get("/api/tmux/agents", asyncHandler(async (_req, res) => {
  const [agents, panes] = await Promise.all([listAvailableAgents(), listTmuxSessions()]);
  res.json({
    data: {
      session: NEW_AGENT_TMUX_SESSION,
      agents: agents.map(({ id, label }) => ({ id, label })),
      directories: await listAgentDirectories(panes)
    } satisfies AgentsDto
  });
}));

app.post("/api/tmux/agents/start", asyncHandler(async (req, res) => {
  const body = req.body as Record<string, unknown>;
  const started = await startAgentInTmux(body.agent, body.cwd);
  tmuxLastInput.record(started.pane);
  res.json({
    data: { ...started, sessions: await listTmuxSessionsWithStatus() } satisfies StartAgentResultDto
  });
}));

app.post("/api/tmux/destroy", asyncHandler(async (req, res) => {
  const body = req.body as Record<string, unknown>;
  const requested = requireString(body.session, "session");
  const entries = await listTmuxSessions();
  // Destroy stays session-level: a pane target resolves to the session that owns it.
  const session = resolveTmuxSessionName(entries, requested);
  for (const [rawTarget, raw] of rawTerminalSessions) {
    if (raw.baseSession === session) {
      raw.close();
      await killTmuxSessionQuietly(rawTarget);
    }
  }
  await destroyTmuxSession(session);
  tmuxWatch.cancelWatch(requested);
  for (const entry of entries) {
    if (entry.session === session) {
      tmuxWatch.cancelWatch(entry.name);
    }
  }
  res.json({
    data: await listTmuxSessionsWithStatus()
  });
}));

app.post("/api/tmux/close-pane", asyncHandler(async (req, res) => {
  const body = req.body as Record<string, unknown>;
  const entry = resolveClosableTmuxPane(await listTmuxSessions(), body.pane);
  await closeTmuxPane(entry.name);
  tmuxWatch.cancelWatch(entry.name);
  res.json({
    data: await listTmuxSessionsWithStatus()
  });
}));

app.post("/api/tmux/open-codex", asyncHandler(async (req, res) => {
  const body = req.body as Record<string, unknown>;
  const session = requireString(body.session, "session");
  tmuxLastInput.record(session);
  await openCodexInTmux(session, {
    cwd: stringOrNull(body.cwd) ?? process.cwd(),
    model: stringOrNull(body.model)
  });
  tmuxWatch.startWatch(session, "Codex");
  const capture = await captureTmuxPaneView(session, TMUX_CAPTURE_HISTORY_LINES);
  res.json({ ok: true, session, ...capture } satisfies TmuxCaptureDto & { ok: true });
}));

app.post("/api/tmux/open-tool", asyncHandler(async (req, res) => {
  const body = req.body as Record<string, unknown>;
  const session = requireString(body.session, "session");
  const requestedToolId = stringOrNull(body.toolId);
  const configuredTool = requestedToolId
    ? listTmuxTools().find((tool) => tool.id === requestedToolId)
    : null;
  const modeIds = Array.isArray(body.modeIds) ? stringArray(body.modeIds) : undefined;
  const command = configuredTool?.command ?? requireString(body.command, "command");
  tmuxLastInput.record(session);
  await openTmuxTool(session, configuredTool ?? { command }, configuredTool ? modeIds : []);
  tmuxWatch.startWatch(session, configuredTool?.label ?? command);
  const capture = await captureTmuxPaneView(session, TMUX_CAPTURE_HISTORY_LINES);
  res.json({ ok: true, session, ...capture } satisfies TmuxCaptureDto & { ok: true });
}));

app.post("/api/tmux/send", asyncHandler(async (req, res) => {
  const body = req.body as Record<string, unknown>;
  const session = requireString(body.session, "session");
  const enter = body.enter !== false;
  tmuxLastInput.record(session);
  await sendTmuxText(
    session,
    requireString(body.text, "text"),
    enter,
    enter ? await resolveTmuxSubmitKey(session, body.submitKey) : "enter"
  );
  if (enter) {
    tmuxWatch.startWatch(session, stringOrNull(body.label) ?? "Tmux task");
  }
  res.json({ ok: true });
}));

app.post("/api/tmux/interrupt", asyncHandler(async (req, res) => {
  const body = req.body as Record<string, unknown>;
  const session = requireString(body.session, "session");
  tmuxLastInput.record(session);
  await interruptTmuxPane(session, await resolveTmuxInterruptKey(session, body.interruptKey));
  tmuxWatch.cancelWatch(session);
  const capture = await captureTmuxPaneView(session, TMUX_CAPTURE_HISTORY_LINES);
  res.json({ ok: true, session, ...capture } satisfies TmuxCaptureDto & { ok: true });
}));

app.post("/api/tmux/keys", asyncHandler(async (req, res) => {
  const body = req.body as Record<string, unknown>;
  const session = requireString(body.session, "session");
  await sendTmuxKey(session, typeof body.key === "string" ? body.key : "");
  tmuxLastInput.record(session);
  res.json({ ok: true });
}));

app.post("/api/tmux/watch", asyncHandler(async (req, res) => {
  const body = req.body as Record<string, unknown>;
  const session = requireString(body.session, "session");
  res.json({
    ok: true,
    watch: tmuxWatch.startWatch(session, stringOrNull(body.label) ?? "Tmux task")
  });
}));

app.delete("/api/tmux/watch/:session", asyncHandler(async (req, res) => {
  tmuxWatch.cancelWatch(String(req.params.session));
  res.json({ ok: true });
}));

app.get("/api/tmux/watch/events", asyncHandler(async (req, res) => {
  const since = typeof req.query.since === "string" ? Number(req.query.since) : 0;
  const cursor = Number.isFinite(since) && since > 0 ? Math.floor(since) : 0;
  recordWatchPoll(req, cursor);
  res.json({
    data: tmuxWatch.getEventsSince(cursor),
    latestEventId: tmuxWatch.latestEventId(),
    baselineEventId: tmuxWatch.latestBaselineEventId(),
    watches: tmuxWatch.listWatches()
  });
}));

app.get("/api/tmux/watch/status", asyncHandler(async (_req, res) => {
  res.json({
    latestEventId: tmuxWatch.latestEventId(),
    baselineEventId: tmuxWatch.latestBaselineEventId(),
    watches: tmuxWatch.listWatches(),
    recentEvents: tmuxWatch.getEventsSince(Math.max(0, tmuxWatch.latestEventId() - 10)),
    pollers: listRecentWatchPollers()
  });
}));

async function listTmuxSessionsWithStatus(excludedBrowserClientId?: string | null): Promise<TmuxSessionDto[]> {
  const sessions = await listTmuxSessions();
  const [harnessStatuses, clientActivity, paneAgents, gpmonStatuses] = await Promise.all([
    readTmuxHarnessStatuses(sessions),
    readTmuxClientActivity(),
    readTmuxPaneAgents(sessions),
    agentRowsCache.statuses()
  ]);
  const nowMs = Date.now();
  // Local panes only: list-clients and Claude's session files describe this host's tmux server.
  const localPanes = sessions.filter((session) => session.name === session.paneId);
  const promptTimes = claudePromptTimes.get(localPanes.map((session) => ({ paneId: session.name, panePid: session.panePid })));
  return Promise.all(sessions.map(async (session) => {
    const {
      clientCount,
      panePid: _panePid,
      currentPath: _currentPath,
      windowId: _windowId,
      ...sessionData
    } = session;
    const output = await captureTmuxVisiblePane(session.name).catch(() => "");
    const visibleStatus = classifyTmuxStatus({
      activityAtMs: session.activityAtMs,
      nowMs,
      output
    });
    const local = session.name === session.paneId;
    // gpmon's cache describes this host's tmux server, so shim panes keep atw's heuristics.
    const status = resolveTmuxSessionStatus(
      local ? gpmonStatuses.get(session.name) : undefined,
      visibleStatus,
      harnessStatuses.get(session.name)
    );
    const lastInputAtMs = latestTmuxInputAtMs(
      tmuxLastInput.get(session.name),
      local ? clientActivity.get(session.name) : undefined,
      local ? promptTimes.get(session.name) : undefined
    );
    const agent = paneAgents.get(session.name);
    return {
      ...sessionData,
      ...(agent ? { agent, label: buildTmuxPaneAgentLabel(session, agent) } : {}),
      ...(lastInputAtMs ? { lastInputAtMs } : {}),
      // Raw browsers attach through grouped sessions, so add other browsers' raw views explicitly.
      viewerCount: Math.max(0, clientCount + totalRawTerminalClientCount(session.name) - rawTerminalClientCount(excludedBrowserClientId, session.name)),
      status
    };
  }));
}

function rawTerminalClientCount(browserClientId: string | null | undefined, session: string): number {
  return browserClientId ? rawTerminalClients.get(browserClientId)?.get(session) ?? 0 : 0;
}

function totalRawTerminalClientCount(session: string): number {
  let total = 0;
  for (const sessions of rawTerminalClients.values()) {
    total += sessions.get(session) ?? 0;
  }
  return total;
}

function updateRawTerminalClientCount(browserClientId: string, session: string, delta: 1 | -1): void {
  const sessions = rawTerminalClients.get(browserClientId) ?? new Map<string, number>();
  const nextCount = Math.max(0, (sessions.get(session) ?? 0) + delta);
  if (nextCount > 0) {
    sessions.set(session, nextCount);
    rawTerminalClients.set(browserClientId, sessions);
    return;
  }
  sessions.delete(session);
  if (sessions.size === 0) {
    rawTerminalClients.delete(browserClientId);
  }
}

app.post("/api/uploads", asyncHandler(async (req, res) => {
  const originalName = requireString(req.query.filename, "filename");
  const file = await saveUploadedFileForClient(req, {
    originalName,
    mimeType: stringOrNull(req.header("content-type"))
  });
  res.json({ file });
}));

app.post("/api/server-request/:requestId/respond", asyncHandler(async (req, res) => {
  bridge.respondToServerRequest(String(req.params.requestId), (req.body as Record<string, unknown>).result);
  res.json({ ok: true });
}));

const clientDist = path.join(process.cwd(), "dist", "client");
if (developmentMode) {
  const { createServer: createViteServer } = await import("vite");
  const tailscaleDns = await readTailscale().then((tailscale) => tailscale.dns).catch(() => null);
  const allowedHosts = [...new Set([
    bindHost,
    tailscaleDns,
    ...(process.env.AGENT_TMUX_WEB_DEV_ALLOWED_HOSTS ?? "").split(",")
  ].map((host) => host?.trim()).filter((host): host is string => Boolean(host)))];
  const vite = await createViteServer({
    appType: "spa",
    configFile: path.join(process.cwd(), "vite.config.ts"),
    server: {
      allowedHosts,
      hmr: { server },
      middlewareMode: true
    }
  });
  app.use(vite.middlewares);
} else {
  app.use(express.static(clientDist));
  app.use((req, res, next) => {
    if (req.method !== "GET" || req.path.startsWith("/api/")) {
      next();
      return;
    }
    res.sendFile(path.join(clientDist, "index.html"));
  });
}

const wss = new WebSocketServer({ noServer: true });
wss.on("connection", async (socket, req) => {
  if (!isAuthorizedWebSocketRequest(authToken, req, tailscaleLogins)) {
    socket.close(1008, "Unauthorized");
    return;
  }

  sockets.add(socket);
  socket.on("close", () => sockets.delete(socket));
  socket.send(JSON.stringify({
    type: "hello",
    status: await getStatus()
  }));
});

const tmuxWss = new WebSocketServer({ noServer: true });
tmuxWss.on("connection", async (socket, req) => {
  const url = new URL(req.url ?? "/tmux-ws", `http://${req.headers.host ?? "localhost"}`);
  if (!isAuthorizedWebSocketRequest(authToken, req, tailscaleLogins)) {
    socket.close(1008, "Unauthorized");
    return;
  }

  const requested = stringOrNull(url.searchParams.get("session"));
  if (!requested) {
    sendTerminalMessage(socket, { type: "error", message: "Missing tmux session" });
    socket.close(1008, "Missing tmux session");
    return;
  }
  const entry = resolveTmuxPaneEntry(await listTmuxSessions().catch(() => []), requested);
  const paneTarget = entry ? splitTmuxPaneTarget(entry.name) : null;
  if (!entry?.session || !paneTarget) {
    sendTerminalMessage(socket, { type: "error", message: `Unknown tmux pane ${requested}` });
    socket.close(1008, "Unknown tmux pane");
    return;
  }
  const session = entry.name;
  const rawSession = `${TMUX_RAW_SESSION_PREFIX}${randomBytes(4).toString("hex")}`;
  const rawTarget = `${paneTarget.routingPrefix}${rawSession}`;
  const browserClientId = stringOrNull(url.searchParams.get("clientId"));
  if (browserClientId) {
    updateRawTerminalClientCount(browserClientId, session, 1);
    socket.once("close", () => updateRawTerminalClientCount(browserClientId, session, -1));
  }

  const size = normalizeTerminalSize(url.searchParams.get("cols"), url.searchParams.get("rows"));
  const viewers = await readTmuxViewerCounts(session).catch(() => ({ sessionClients: 0, windowClients: 0 }));
  const rawTerminalPolicy = buildBrowserRawTerminalPolicy({
    hasAttachedClients: viewers.sessionClients > 0,
    windowViewedByOtherClients: viewers.windowClients > 0
  });
  const initialWindowState = rawTerminalPolicy.resizeTmuxWindowOnAttach
    ? await readTmuxWindowState(session).catch(() => null)
    : null;
  let cleanedUp = false;
  const cleanup = async () => {
    if (cleanedUp) {
      return;
    }
    cleanedUp = true;
    rawTerminalSessions.delete(rawTarget);
    await killTmuxSessionQuietly(rawTarget);
    // Best-effort cleanup; the tmux window should not remain manually sized.
    await restoreTmuxWindowState(session, initialWindowState).catch(() => undefined);
  };

  if (rawTerminalPolicy.resizeTmuxWindowOnAttach) {
    await resizeTmuxWindowIfNeeded(session, size).catch(() => {
      // Best-effort initial resize; the browser PTY is still sized before attach.
    });
  }
  if (socket.readyState !== socket.OPEN) {
    await cleanup();
    return;
  }

  const scriptSpawn = buildScriptSpawn(buildTmuxGroupedAttachShellCommand({
    baseSession: entry.session,
    rawSession,
    windowId: entry.windowId,
    paneId: paneTarget.paneId
  }, rawTerminalPolicy.attachOptions, size));
  // tmux refuses to attach from inside a pane, and the server may have been started from one.
  const { TMUX: _tmux, TMUX_PANE: _tmuxPane, ...parentEnv } = process.env;
  const child = spawn(scriptSpawn.file, scriptSpawn.args, {
    cwd: process.env.HOME ?? process.cwd(),
    env: {
      ...parentEnv,
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      COLUMNS: String(size.cols),
      LINES: String(size.rows)
    },
    stdio: ["pipe", "pipe", "pipe"]
  });
  rawTerminalSessions.set(rawTarget, {
    baseSession: entry.session,
    close: () => {
      if (socket.readyState === socket.OPEN) {
        socket.close(1000, "tmux session destroyed");
      }
    }
  });

  sendTerminalMessage(socket, { type: "status", message: `live terminal for ${entry.label ?? session}` });

  child.stdout.on("data", (chunk: Buffer) => {
    sendTerminalMessage(socket, { type: "output", data: chunk.toString("utf8") });
  });
  child.stderr.on("data", (chunk: Buffer) => {
    sendTerminalMessage(socket, { type: "output", data: chunk.toString("utf8") });
  });
  child.on("error", (error) => {
    sendTerminalMessage(socket, { type: "error", message: error.message });
  });
  child.on("exit", (code, signal) => {
    // Lets the darwin stdin relay (cat) see EOF and exit.
    child.stdin.destroy();
    void cleanup();
    sendTerminalMessage(socket, { type: "status", message: `tmux detached (${code ?? signal ?? "closed"})` });
    if (socket.readyState === socket.OPEN) {
      socket.close(1000, "tmux detached");
    }
  });

  socket.on("message", (raw) => {
    const message = parseTerminalMessage(raw);
    if (!message) {
      return;
    }

    if (message.type === "input" && typeof message.data === "string") {
      child.stdin.write(message.data);
      tmuxLastInput.record(session);
      if (/[\r\n]/.test(message.data)) {
        tmuxWatch.startWatch(session, "Tmux task");
      }
      return;
    }

    if (message.type === "resize" && rawTerminalPolicy.resizeTmuxWindow) {
      const nextSize = normalizeTerminalSize(message.cols, message.rows);
      readTmuxViewerCounts(session)
        // Our own client counts as one viewer; skip if a desktop client switched to this window.
        .then(({ windowClients }) => windowClients <= 1 ? resizeTmuxWindowIfNeeded(session, nextSize) : false)
        .catch(() => {
          // Best-effort resize; the tmux attachment remains usable if this fails.
        });
    }
  });

  socket.on("close", () => {
    // Killing the grouped session detaches the browser client, so no prefix keys are sent.
    void cleanup().finally(() => closeTerminalChild(child));
  });
});

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const target = url.pathname === "/ws" ? wss : url.pathname === "/tmux-ws" ? tmuxWss : null;
  if (!target) {
    const viteHmr = developmentMode
      && url.pathname === "/"
      && req.headers["sec-websocket-protocol"] === "vite-hmr";
    if (!viteHmr) socket.destroy();
    return;
  }

  target.handleUpgrade(req, socket, head, (webSocket) => {
    target.emit("connection", webSocket, req);
  });
});

bridge.on("notification", (notification) => {
  broadcast({ type: "codex-notification", notification, description: describeCodexNotification(notification as Record<string, unknown>) });
});
bridge.on("server-request", (request) => {
  broadcast({ type: "codex-server-request", request });
});
bridge.on("status", (status) => {
  broadcast({ type: "codex-status", status });
});
bridge.on("log", (line) => {
  if ((process.env.AGENT_TMUX_WEB_VERBOSE ?? process.env.CODEX_WEB_VERBOSE) === "1") {
    console.error(line.trim());
  }
});

server.listen(port, bindHost, async () => {
  console.log(`agent-tmux-web listening on http://${bindHost}:${port}`);
  startUploadCleanup();
  void tmuxLastInput.load();
  void sweepOrphanedRawSessions();
  tmuxWatch.startAutoPoll();
  if (codexAppServerAutostart) {
    bridge.start().catch((error: unknown) => {
      console.error("Failed to start Codex bridge", error);
    });
  }
});

async function sweepOrphanedRawSessions(): Promise<void> {
  // Raw sessions left by a crashed server have no clients; destroy-unattached only fires on detach.
  for (const rawTarget of await listOrphanedTmuxRawSessions()) {
    await killTmuxSessionQuietly(rawTarget);
  }
}

function asyncHandler(handler: (req: Request, res: Response, next: NextFunction) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    handler(req, res, next).catch(next);
  };
}

function isPublicAssetRequest(req: Request): boolean {
  const normalizedPath = req.path.toLowerCase();
  return req.method === "GET" && (
    normalizedPath.startsWith("/assets/")
    || normalizedPath === "/agent-tmux-logo.png"
    || normalizedPath === "/apple-touch-icon.png"
    || normalizedPath === "/favicon.ico"
    || normalizedPath === "/favicon.png"
    || (developmentMode && req.path !== "/" && !normalizedPath.startsWith("/api/"))
  );
}

function sendTerminalMessage(socket: WebSocket, payload: unknown): void {
  if (socket.readyState === socket.OPEN) {
    socket.send(JSON.stringify(payload));
  }
}

function closeTerminalChild(child: ChildProcessWithoutNullStreams): void {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  if (child.stdin.writable) {
    child.stdin.end();
  }

  const timer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
    }
  }, 500);
  timer.unref();
}

function parseTerminalMessage(raw: RawData): Record<string, unknown> | null {
  const text = rawToString(raw);
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

async function readTmuxWindowState(session: string): Promise<TmuxWindowState> {
  const [size, { stdout: optionStdout }] = await Promise.all([
    readTmuxWindowSize(session),
    execFileAsync("tmux", buildTmuxShowWindowSizeOptionArgs(session))
  ]);
  return {
    size,
    windowSizeOption: optionStdout.trim() || "latest"
  };
}

async function readTmuxWindowSize(session: string): Promise<TerminalSize> {
  const { stdout } = await execFileAsync("tmux", buildTmuxDisplayWindowSizeArgs(session));
  return parseTmuxWindowSize(stdout);
}

async function resizeTmuxWindowIfNeeded(session: string, nextSize: TerminalSize): Promise<boolean> {
  const currentSize = await readTmuxWindowSize(session);
  if (isSameTerminalSize(currentSize, nextSize)) {
    return false;
  }
  await execFileAsync("tmux", buildTmuxResizeWindowArgs(session, nextSize));
  return true;
}

async function hasAttachedTmuxClients(target: string): Promise<boolean> {
  const { sessionClients, windowClients } = await readTmuxViewerCounts(target);
  return sessionClients > 0 || windowClients > 0;
}

async function restoreTmuxWindowState(session: string, state: TmuxWindowState | null): Promise<void> {
  if (!state) {
    return;
  }

  for (const args of buildTmuxRestoreWindowStateCommandSequence(session, state)) {
    await execFileAsync("tmux", args);
  }
}

async function resolveTmuxSubmitKey(session: string, requested: unknown): Promise<TmuxSubmitKey> {
  if (requested === "enter" || requested === "tab" || requested === "codex-enter") {
    return requested;
  }
  return detectTmuxSubmitKey(await captureTmuxPane(session, 220));
}

async function resolveTmuxInterruptKey(session: string, requested: unknown): Promise<TmuxInterruptKey> {
  if (requested === "escape" || requested === "ctrl-c") {
    return requested;
  }
  return detectTmuxInterruptKey(await captureTmuxPane(session, 220));
}

function rawToString(raw: RawData): string {
  if (typeof raw === "string") {
    return raw;
  }
  if (Buffer.isBuffer(raw)) {
    return raw.toString("utf8");
  }
  if (Array.isArray(raw)) {
    return Buffer.concat(raw).toString("utf8");
  }
  return Buffer.from(raw).toString("utf8");
}

function startUploadCleanup(): void {
  const clean = () => {
    void cleanupUploadRoots(
      [resolveUploadRoot(), resolveLegacyUploadRoot()],
      resolveUploadAliasRoot()
    ).catch((error: unknown) => {
      console.error("Failed to clean expired uploads", error);
    });
  };

  clean();
  const timer = setInterval(clean, 60 * 60 * 1000);
  timer.unref();
}

function recordWatchPoll(req: Request, since: number): void {
  const userAgent = req.header("user-agent") ?? "";
  const explicitClient = req.header("x-agent-tmux-web-client") ?? "";
  const remoteAddress = req.ip || req.socket.remoteAddress || "unknown";
  const id = `${explicitClient || userAgent || "unknown"} ${remoteAddress}`;
  watchPollers.set(id, {
    id,
    lastSeen: new Date().toISOString(),
    remoteAddress,
    since,
    userAgent
  });
}

function listRecentWatchPollers(): Array<{
  id: string;
  lastSeen: string;
  remoteAddress: string;
  secondsAgo: number;
  since: number;
  userAgent: string;
}> {
  const now = Date.now();
  return [...watchPollers.values()]
    .map((poller) => ({
      ...poller,
      secondsAgo: Math.round((now - Date.parse(poller.lastSeen)) / 1000)
    }))
    .filter((poller) => poller.secondsAgo <= 10 * 60)
    .sort((left, right) => left.secondsAgo - right.secondsAgo);
}

app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const message = error instanceof Error ? error.message : String(error);
  const record = error && typeof error === "object" ? error as Record<string, unknown> : {};
  const statusCode = typeof record.statusCode === "number" ? record.statusCode : 500;
  if (statusCode >= 500) {
    console.error("Request failed", error);
  }
  res.status(statusCode).json({ error: message });
});

function broadcast(payload: unknown): void {
  recentEvents.push(payload);
  if (recentEvents.length > 500) {
    recentEvents.splice(0, recentEvents.length - 500);
  }

  const encoded = JSON.stringify(payload);
  for (const socket of sockets) {
    if (socket.readyState === socket.OPEN) {
      socket.send(encoded);
    }
  }
}

async function getStatus(): Promise<AppStatus> {
  const tailscale = await readTailscale().catch(() => ({ ip: null, dns: null }));
  return {
    environment: runtimeEnvironment,
    bindHost,
    port,
    defaultCwd,
    tailscaleIp: tailscale.ip,
    tailscaleDns: tailscale.dns,
    codex: {
      connected: bridge.connected,
      appServerUrl: bridge.appServerUrl,
      initialized: bridge.initialized,
      lastError: bridge.lastError
    }
  };
}

async function readTailscale(): Promise<{ ip: string | null; dns: string | null }> {
  const [{ stdout: ipStdout }, { stdout: statusStdout }] = await Promise.all([
    execFileAsync("tailscale", ["ip", "-4"]),
    execFileAsync("tailscale", ["status", "--json"])
  ]);
  const status = JSON.parse(statusStdout) as { Self?: { DNSName?: string } };
  return {
    ip: ipStdout.trim().split(/\s+/)[0] || null,
    dns: status.Self?.DNSName?.replace(/\.$/, "") ?? null
  };
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function requireString(value: unknown, name: string): string {
  const result = stringOrNull(value);
  if (!result) {
    throw new Error(`Missing required field: ${name}`);
  }
  return result;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.flatMap((entry) => stringOrNull(entry) ?? []) : [];
}

function buildUserInput(text: string, skills: unknown) {
  const skillInputs = Array.isArray(skills)
    ? skills.flatMap((skill) => {
        const record = skill && typeof skill === "object" ? (skill as Record<string, unknown>) : {};
        const name = stringOrNull(record.name);
        const skillPath = stringOrNull(record.path);
        return name && skillPath ? [{ type: "skill", name, path: skillPath }] : [];
      })
    : [];

  return [
    ...skillInputs,
    {
      type: "text",
      text,
      text_elements: []
    }
  ];
}
