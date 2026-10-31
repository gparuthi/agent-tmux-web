import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { Router, type NextFunction, type Request, type Response } from "express";

import type { ClosedSessionDto, ReopenClosedSessionMode, ReopenClosedSessionResultDto, TmuxSessionDto } from "../shared/api.js";
import { shortenTmuxPanePath, TmuxRequestError, type TmuxSession } from "./tmux.js";

const execFileAsync = promisify(execFile);

export const DEFAULT_CLOSED_SESSIONS_FILE = path.join(os.homedir(), ".local", "state", "atw", "closed-sessions.json");
export const MAX_CLOSED_SESSIONS = 30;
// A closed session's checkpoint rarely changes, so its handoff probe is reused this long.
export const HANDOFF_CACHE_MS = 5 * 60_000;
const HANDOFF_PROBE_CONCURRENCY = 4;
// The autobuild wrapper may rebuild ctx on its first run after an edit.
const CTX_TIMEOUT_MS = 120_000;
const WRITE_DEBOUNCE_MS = 1000;
const FILE_VERSION = 1;
// Claude Code and Codex both name sessions with UUIDs; nothing else reaches ctx's argv.
const AGENT_SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type LiveAgentPane = {
  // Local pane target, e.g. "%12".
  name: string;
  createdAtMs?: number;
  agent: string;
  sessionId: string;
  cwd: string;
  title: string;
  lastPromptAtMs?: number;
};

export type ClosedSession = {
  sessionId: string;
  agent: string;
  cwd: string;
  title: string;
  closedAtMs: number;
  lastPromptAtMs?: number;
};

export function isAgentSessionId(value: unknown): value is string {
  return typeof value === "string" && AGENT_SESSION_ID_PATTERN.test(value);
}

export function isReopenMode(value: unknown): value is ReopenClosedSessionMode {
  return value === "resume" || value === "handoff";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseClosedSession(value: unknown): ClosedSession | null {
  if (!isRecord(value)) {
    return null;
  }
  const { sessionId, agent, cwd, title, closedAtMs, lastPromptAtMs } = value;
  if (!isAgentSessionId(sessionId) || typeof agent !== "string" || !agent || typeof cwd !== "string" || typeof title !== "string"
    || typeof closedAtMs !== "number" || !Number.isFinite(closedAtMs)) {
    return null;
  }
  return {
    sessionId,
    agent,
    cwd,
    title,
    closedAtMs,
    ...(typeof lastPromptAtMs === "number" && Number.isFinite(lastPromptAtMs) ? { lastPromptAtMs } : {})
  };
}

// Newest first, one entry per session id, at most `max`.
export function pruneClosedSessions(entries: ClosedSession[], max = MAX_CLOSED_SESSIONS): ClosedSession[] {
  const seen = new Set<string>();
  return [...entries]
    .sort((left, right) => right.closedAtMs - left.closedAtMs)
    .filter((entry) => {
      if (seen.has(entry.sessionId)) {
        return false;
      }
      seen.add(entry.sessionId);
      return true;
    })
    .slice(0, max);
}

// Local agent panes whose session id is known: Claude from its session file, Codex from `codex resume <id>`.
export function collectLiveAgentPanes(panes: TmuxSession[], sources: {
  agents: Map<string, string>;
  claudeSessions: Map<string, { sessionId: string; cwd: string }>;
  codexSessions: Map<string, string>;
  lastPromptAtMs: (pane: TmuxSession) => number | undefined;
}): LiveAgentPane[] {
  return panes.flatMap((pane) => {
    if (pane.name !== pane.paneId) {
      return [];
    }
    const claude = sources.claudeSessions.get(pane.name);
    const codexId = sources.agents.get(pane.name) === "codex" ? sources.codexSessions.get(pane.name) : undefined;
    const known = claude ? { agent: "claude", ...claude } : codexId ? { agent: "codex", sessionId: codexId, cwd: pane.currentPath ?? "" } : null;
    if (!known || !isAgentSessionId(known.sessionId)) {
      return [];
    }
    const lastPromptAtMs = sources.lastPromptAtMs(pane);
    return [{
      name: pane.name,
      ...(pane.createdAtMs ? { createdAtMs: pane.createdAtMs } : {}),
      ...known,
      title: pane.displayName ?? pane.name,
      ...(lastPromptAtMs ? { lastPromptAtMs } : {})
    }];
  });
}

export function parseClosedSessionsFile(serialized: string): ClosedSession[] {
  try {
    const document: unknown = JSON.parse(serialized);
    if (!isRecord(document) || document.version !== FILE_VERSION || !Array.isArray(document.entries)) {
      return [];
    }
    return pruneClosedSessions(document.entries.flatMap((entry) => parseClosedSession(entry) ?? []));
  } catch {
    return [];
  }
}

// Agent panes seen live, and the sessions whose pane has since gone; the list is persisted, live panes are not,
// so closures while the server was down go unrecorded.
export class ClosedSessionTracker {
  private live = new Map<string, LiveAgentPane>();
  private entries: ClosedSession[] = [];
  private writeTimer: NodeJS.Timeout | null = null;

  constructor(private readonly options: {
    filePath: string | null;
    now?: () => number;
    debounceMs?: number;
    onClosed?: (entry: ClosedSession) => void;
  }) {}

  async load(): Promise<void> {
    if (!this.options.filePath) {
      return;
    }
    const serialized = await readFile(this.options.filePath, "utf8").catch(() => "");
    this.entries = pruneClosedSessions([...this.entries, ...parseClosedSessionsFile(serialized)]);
  }

  // Panes with an agent session right now; a closed session that shows up live again leaves the list.
  remember(panes: LiveAgentPane[]): void {
    const liveIds = new Set<string>();
    for (const pane of panes) {
      this.live.set(pane.name, pane);
      liveIds.add(pane.sessionId);
    }
    const kept = this.entries.filter((entry) => !liveIds.has(entry.sessionId));
    if (kept.length !== this.entries.length) {
      this.entries = kept;
      this.scheduleWrite();
    }
  }

  // Every pane tmux lists now; a remembered pane that is gone, or whose id now names a newer pane, closed.
  sweep(panes: Array<{ name: string; createdAtMs?: number }>): void {
    const present = new Map(panes.map((pane) => [pane.name, pane]));
    for (const [name, pane] of this.live) {
      const current = present.get(name);
      const reused = current !== undefined && pane.createdAtMs !== undefined && current.createdAtMs !== undefined && current.createdAtMs !== pane.createdAtMs;
      if (current === undefined || reused) {
        this.live.delete(name);
        this.record(pane);
      }
    }
  }

  list(): ClosedSession[] {
    return this.entries;
  }

  find(sessionId: string): ClosedSession | undefined {
    return this.entries.find((entry) => entry.sessionId === sessionId);
  }

  remove(sessionId: string): void {
    const kept = this.entries.filter((entry) => entry.sessionId !== sessionId);
    if (kept.length !== this.entries.length) {
      this.entries = kept;
      this.scheduleWrite();
    }
  }

  async flush(): Promise<void> {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
      this.writeTimer = null;
    }
    const filePath = this.options.filePath;
    if (!filePath) {
      return;
    }
    await mkdir(path.dirname(filePath), { recursive: true });
    const temporaryPath = `${filePath}.${process.pid}.tmp`;
    await writeFile(temporaryPath, JSON.stringify({ version: FILE_VERSION, entries: this.entries }));
    await rename(temporaryPath, filePath);
  }

  private record(pane: LiveAgentPane): void {
    const entry: ClosedSession = {
      sessionId: pane.sessionId,
      agent: pane.agent,
      cwd: pane.cwd,
      title: pane.title,
      closedAtMs: (this.options.now ?? Date.now)(),
      ...(pane.lastPromptAtMs ? { lastPromptAtMs: pane.lastPromptAtMs } : {})
    };
    this.entries = pruneClosedSessions([entry, ...this.entries]);
    this.scheduleWrite();
    this.options.onClosed?.(entry);
  }

  private scheduleWrite(): void {
    if (!this.options.filePath || this.writeTimer) {
      return;
    }
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null;
      this.flush().catch((error: unknown) => console.error("Failed to save closed sessions", error));
    }, this.options.debounceMs ?? WRITE_DEBOUNCE_MS);
    this.writeTimer.unref();
  }
}

// Whether each session has a ctx handoff, probed at most once per HANDOFF_CACHE_MS so listing stays cheap.
export class HandoffCache {
  private cache = new Map<string, { has: boolean; atMs: number }>();
  private pending = new Map<string, Promise<boolean>>();

  constructor(
    private readonly probe: (sessionId: string) => Promise<boolean>,
    private readonly now: () => number = Date.now,
    private readonly ttlMs = HANDOFF_CACHE_MS
  ) {}

  refresh(sessionId: string): Promise<boolean> {
    let probing = this.pending.get(sessionId);
    if (!probing) {
      probing = this.probe(sessionId).catch(() => false).then((has) => {
        this.cache.set(sessionId, { has, atMs: this.now() });
        this.pending.delete(sessionId);
        return has;
      });
      this.pending.set(sessionId, probing);
    }
    return probing;
  }

  // Waits only for sessions never probed; stale answers are served while they refresh in the background.
  async lookup(sessionIds: string[]): Promise<Map<string, boolean>> {
    const missing = sessionIds.filter((id) => !this.cache.has(id));
    for (const id of sessionIds) {
      const cached = this.cache.get(id);
      if (cached && this.now() - cached.atMs >= this.ttlMs) {
        void this.refresh(id);
      }
    }
    for (let index = 0; index < missing.length; index += HANDOFF_PROBE_CONCURRENCY) {
      await Promise.all(missing.slice(index, index + HANDOFF_PROBE_CONCURRENCY).map((id) => this.refresh(id)));
    }
    return new Map(sessionIds.map((id) => [id, this.cache.get(id)?.has ?? false]));
  }

  forget(sessionId: string): void {
    this.cache.delete(sessionId);
  }
}

// ATW_CTX_BIN overrides the owner's ~/.gp wrapper; set it empty to turn reopening off.
export function resolveCtxBin(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.ATW_CTX_BIN !== undefined) {
    return env.ATW_CTX_BIN.trim() || null;
  }
  return env.HOME ? path.join(env.HOME, ".gp/tools/context-engine/ctx") : null;
}

export async function findCtxBin(env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  const bin = resolveCtxBin(env);
  if (!bin) {
    return null;
  }
  try {
    await access(bin, fsConstants.X_OK);
    return bin;
  } catch {
    return null;
  }
}

// `ctx cmd <id>` prints the resume line; --fresh prints one that starts a new agent from the session's handoff.
export function buildCtxCmdArgs(sessionId: string, mode: ReopenClosedSessionMode): string[] {
  return ["cmd", sessionId, ...(mode === "handoff" ? ["--fresh"] : [])];
}

// ctx prints exactly one `cd <dir> && <agent> ...` line; anything else is an error message.
export function parseCtxCommand(output: string): string {
  const lines = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length !== 1 || !lines[0].startsWith("cd ")) {
    throw new ClosedSessionError(`ctx printed no command: ${output.trim().slice(0, 200)}`, 502);
  }
  return lines[0];
}

export async function readCtxCommand(ctxBin: string | null, sessionId: string, mode: ReopenClosedSessionMode): Promise<string> {
  if (!ctxBin) {
    throw new ClosedSessionError("Reopening is not available: ctx is not installed", 404);
  }
  try {
    const { stdout } = await execFileAsync(ctxBin, buildCtxCmdArgs(sessionId, mode), { timeout: CTX_TIMEOUT_MS });
    return parseCtxCommand(stdout);
  } catch (error) {
    if (error instanceof ClosedSessionError) {
      throw error;
    }
    const stderr = error && typeof error === "object" && "stderr" in error ? String(error.stderr).trim() : "";
    throw new ClosedSessionError(stderr || `ctx cmd failed for ${sessionId}`, 502);
  }
}

// A session has a handoff exactly when ctx can print its from-handoff line.
export function probeCtxHandoff(ctxBin: () => Promise<string | null>): (sessionId: string) => Promise<boolean> {
  return async (sessionId) => {
    await readCtxCommand(await ctxBin(), sessionId, "handoff");
    return true;
  };
}

export class ClosedSessionError extends Error {
  constructor(message: string, readonly statusCode: number) {
    super(message);
  }
}

export function toClosedSessionDto(entry: ClosedSession, handoff: boolean, homeDir: string | undefined = process.env.HOME): ClosedSessionDto {
  return {
    sessionId: entry.sessionId,
    agent: entry.agent,
    title: entry.title,
    cwd: entry.cwd,
    cwdLabel: shortenTmuxPanePath(entry.cwd, homeDir),
    closedAtMs: entry.closedAtMs,
    ...(entry.lastPromptAtMs ? { lastPromptAtMs: entry.lastPromptAtMs } : {}),
    handoff
  };
}

export type ClosedSessionsRouterOptions = {
  tracker: ClosedSessionTracker;
  handoffs: HandoffCache;
  readCommand: (sessionId: string, mode: ReopenClosedSessionMode) => Promise<string>;
  // Runs ctx's line in a new agent window and returns its pane.
  openWindow: (command: string, entry: ClosedSession) => Promise<{ pane: string; directory: string; windowName: string }>;
  listSessions: () => Promise<TmuxSessionDto[]>;
  onOpened?: (pane: string) => void;
};

export function createClosedSessionsRouter(options: ClosedSessionsRouterOptions): Router {
  const router = Router();

  async function listClosed(): Promise<ClosedSessionDto[]> {
    const entries = options.tracker.list();
    const handoffs = await options.handoffs.lookup(entries.map((entry) => entry.sessionId));
    return entries.map((entry) => toClosedSessionDto(entry, handoffs.get(entry.sessionId) ?? false));
  }

  router.get("/api/tmux/closed-sessions", handle(async (_req, res) => {
    res.json({ data: await listClosed() });
  }));

  router.post("/api/tmux/closed-sessions/reopen", handle(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (!isAgentSessionId(body.sessionId)) {
      throw new TmuxRequestError(`Invalid session id: ${JSON.stringify(body.sessionId ?? null).slice(0, 60)}`);
    }
    if (!isReopenMode(body.mode)) {
      throw new TmuxRequestError(`Invalid mode: ${JSON.stringify(body.mode ?? null).slice(0, 20)}; use resume or handoff`);
    }
    // Only sessions atw saw close, so a crafted id never reaches ctx.
    const entry = options.tracker.find(body.sessionId);
    if (!entry) {
      throw new ClosedSessionError(`No recently closed session ${body.sessionId}`, 404);
    }
    const command = await options.readCommand(entry.sessionId, body.mode);
    const opened = await options.openWindow(command, entry);
    options.tracker.remove(entry.sessionId);
    options.handoffs.forget(entry.sessionId);
    options.onOpened?.(opened.pane);
    const [sessions, closed] = await Promise.all([options.listSessions(), listClosed()]);
    res.json({ data: { ...opened, sessions, closed } satisfies ReopenClosedSessionResultDto });
  }));

  return router;
}

function handle(handler: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    handler(req, res).catch(next);
  };
}
