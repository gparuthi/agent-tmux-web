import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { Router, type NextFunction, type Request, type Response } from "express";

import type { ClosedSessionDto, ReopenClosedSessionMode, ReopenClosedSessionResultDto, TmuxSessionDto } from "../shared/api.js";
import { shortenTmuxPanePath, TmuxRequestError } from "./tmux.js";

const execFileAsync = promisify(execFile);

export const MAX_CLOSED_SESSIONS = 30;
// ctx prompts takes ~0.1-0.5s; the list is served from this cache and refreshed in the background.
export const CTX_PROMPTS_CACHE_MS = 30_000;
// A reopened session stays hidden this long, until the Claude session scan sees its new pane.
export const REOPENED_GRACE_MS = 60_000;
// A closed session's checkpoint rarely changes, so its handoff probe is reused this long.
export const HANDOFF_CACHE_MS = 5 * 60_000;
const HANDOFF_PROBE_CONCURRENCY = 4;
// The autobuild wrapper may rebuild ctx on its first run after an edit.
const CTX_TIMEOUT_MS = 120_000;
const CTX_PROMPTS_MAX_BUFFER_BYTES = 16 * 1024 * 1024;
const MAX_TITLE_CHARS = 60;
const MAX_PROMPT_CHARS = 300;
// Claude Code and Codex both name sessions with UUIDs; nothing else reaches ctx's argv.
const AGENT_SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// One session from `ctx prompts --json`, newest owner prompt first.
export type CtxPromptSession = {
  sessionId: string;
  host: string;
  harness: string;
  project: string;
  name: string;
  prompt: string;
  promptedAtMs: number;
};

export type ClosedSession = {
  sessionId: string;
  agent: string;
  title: string;
  cwd: string;
  lastPrompt: string;
  lastPromptAtMs: number;
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

// `--host local` lets ctx resolve this machine's name itself (TW_HOSTNAME, else scutil LocalHostName, aliased), which
// need not match os.hostname(); it also skips the synced copies from other hosts.
export function buildCtxPromptsArgs(): string[] {
  return ["prompts", "--json", "--host", "local", "--since", "7d", "-k", "60"];
}

export function parseCtxPrompts(output: string): CtxPromptSession[] {
  let document: unknown;
  try {
    document = JSON.parse(output);
  } catch {
    throw new ClosedSessionError(`ctx prompts printed no JSON: ${output.trim().slice(0, 200)}`, 502);
  }
  if (!isRecord(document) || !Array.isArray(document.sessions)) {
    throw new ClosedSessionError("ctx prompts printed no sessions list", 502);
  }
  return document.sessions.flatMap((value): CtxPromptSession[] => {
    if (!isRecord(value)) {
      return [];
    }
    const { session_id: sessionId, host, harness, project, name, prompt, prompted_at: promptedAt } = value;
    const promptedAtMs = typeof promptedAt === "string" ? Date.parse(promptedAt) : Number.NaN;
    if (typeof sessionId !== "string" || typeof host !== "string" || typeof harness !== "string" || typeof project !== "string"
      || !Number.isFinite(promptedAtMs)) {
      return [];
    }
    return [{
      sessionId,
      host,
      harness,
      project,
      name: typeof name === "string" ? name : "",
      prompt: typeof prompt === "string" ? prompt : "",
      promptedAtMs
    }];
  });
}

export async function readCtxPrompts(ctxBin: string | null): Promise<CtxPromptSession[]> {
  if (!ctxBin) {
    return [];
  }
  try {
    const { stdout } = await execFileAsync(ctxBin, buildCtxPromptsArgs(), { timeout: CTX_TIMEOUT_MS, maxBuffer: CTX_PROMPTS_MAX_BUFFER_BYTES });
    return parseCtxPrompts(stdout);
  } catch (error) {
    if (error instanceof ClosedSessionError) {
      throw error;
    }
    const stderr = error && typeof error === "object" && "stderr" in error ? String(error.stderr).trim() : "";
    throw new ClosedSessionError(stderr || "ctx prompts failed", 502);
  }
}

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

// Unnamed sessions are titled by their last prompt, cut to fit a row.
export function closedSessionTitle(name: string, prompt: string, sessionId: string): string {
  return collapseWhitespace(name) || truncate(collapseWhitespace(prompt), MAX_TITLE_CHARS) || sessionId.slice(0, 8);
}

// Claude sessions not running in a tmux pane now, newest prompt first, one per id, at most `max`.
export function selectRecentlyClosed(sessions: CtxPromptSession[], liveIds: Set<string>, max = MAX_CLOSED_SESSIONS): ClosedSession[] {
  const seen = new Set<string>();
  return [...sessions]
    .sort((left, right) => right.promptedAtMs - left.promptedAtMs)
    .filter((session) => {
      if (session.harness !== "claude" || !isAgentSessionId(session.sessionId) || liveIds.has(session.sessionId) || seen.has(session.sessionId)) {
        return false;
      }
      seen.add(session.sessionId);
      return true;
    })
    .slice(0, max)
    .map((session) => ({
      sessionId: session.sessionId,
      agent: "claude",
      title: closedSessionTitle(session.name, session.prompt, session.sessionId),
      cwd: session.project,
      lastPrompt: truncate(collapseWhitespace(session.prompt), MAX_PROMPT_CHARS),
      lastPromptAtMs: session.promptedAtMs
    }));
}

// The last `ctx prompts` answer: the first read is awaited, later stale reads refresh once in the background.
export class CtxPromptsCache {
  private value: CtxPromptSession[] | null = null;
  private readAtMs = 0;
  private pending: Promise<CtxPromptSession[]> | null = null;

  constructor(
    private readonly read: () => Promise<CtxPromptSession[]>,
    private readonly now: () => number = Date.now,
    private readonly ttlMs = CTX_PROMPTS_CACHE_MS
  ) {}

  async get(): Promise<CtxPromptSession[]> {
    if (this.value === null) {
      return this.refresh();
    }
    if (this.now() - this.readAtMs >= this.ttlMs) {
      void this.refresh().catch(() => undefined);
    }
    return this.value;
  }

  refresh(): Promise<CtxPromptSession[]> {
    if (!this.pending) {
      this.pending = this.read().then((sessions) => {
        this.value = sessions;
        this.readAtMs = this.now();
        return sessions;
      }, (error: unknown) => {
        // A failed refresh keeps the last list and waits a full interval before trying again.
        this.readAtMs = this.now();
        if (this.value === null) {
          throw error;
        }
        return this.value;
      }).finally(() => {
        this.pending = null;
      });
    }
    return this.pending;
  }
}

// Claude's own history (via ctx) minus the sessions live in a tmux pane, so sessions that ended while atw was down count.
export class RecentlyClosedSessions {
  private reopened = new Map<string, number>();

  constructor(private readonly options: {
    prompts: () => Promise<CtxPromptSession[]>;
    // Session ids live in a local pane; null until the Claude session scan has run once.
    liveSessionIds: () => Promise<Set<string> | null>;
    now?: () => number;
    max?: number;
  }) {}

  async list(): Promise<ClosedSession[]> {
    const [liveIds, prompts] = await Promise.all([this.options.liveSessionIds(), this.options.prompts()]);
    if (!liveIds) {
      return [];
    }
    const nowMs = (this.options.now ?? Date.now)();
    for (const [sessionId, atMs] of this.reopened) {
      if (nowMs - atMs >= REOPENED_GRACE_MS) {
        this.reopened.delete(sessionId);
      }
    }
    return selectRecentlyClosed(prompts, new Set([...liveIds, ...this.reopened.keys()]), this.options.max);
  }

  markReopened(sessionId: string): void {
    this.reopened.set(sessionId, (this.options.now ?? Date.now)());
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
    lastPrompt: entry.lastPrompt,
    lastPromptAtMs: entry.lastPromptAtMs,
    handoff
  };
}

export type ClosedSessionsRouterOptions = {
  closed: RecentlyClosedSessions;
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
    const closed = await options.closed.list();
    const handoffs = await options.handoffs.lookup(closed.map((entry) => entry.sessionId));
    return closed.map((entry) => toClosedSessionDto(entry, handoffs.get(entry.sessionId) ?? false));
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
    // Only sessions in the list the client sees, so a crafted id never reaches ctx.
    const entry = (await options.closed.list()).find((candidate) => candidate.sessionId === body.sessionId);
    if (!entry) {
      throw new ClosedSessionError(`No recently closed session ${body.sessionId}`, 404);
    }
    const command = await options.readCommand(entry.sessionId, body.mode);
    const opened = await options.openWindow(command, entry);
    options.closed.markReopened(entry.sessionId);
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
