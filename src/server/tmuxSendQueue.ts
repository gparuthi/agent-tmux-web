import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Router, type NextFunction, type Request, type Response } from "express";

import type { TmuxQueuedMessageDto, TmuxSendResultDto } from "../shared/api.js";
import { tmuxAgentDropsTypeAhead } from "../shared/tmuxAgents.js";
import type { AgentRow, AgentRowsSnapshot } from "./agentRows.js";
import { TmuxRequestError, type TmuxSubmitKey } from "./tmux.js";

export const DEFAULT_TMUX_SEND_QUEUE_FILE = path.join(os.homedir(), ".local", "state", "atw", "send-queue.json");
export const SEND_QUEUE_TICK_MS = 1000;
// With no working state seen, a send counts as finished once a snapshot this much newer still reads ready;
// hax draws its input line only while it waits for input, so a ready screen after the Enter means the turn ended.
export const SEND_SETTLE_MS = 4000;
// A send's turn tracking is forgotten after this long.
export const SEND_TRACK_TTL_MS = 10 * 60_000;
const READY_STATES: ReadonlySet<string> = new Set(["done", "idle", "blocked"]);
const SUBMIT_KEYS: ReadonlySet<string> = new Set(["enter", "tab", "codex-enter"]);
const FILE_VERSION = 1;

export type TmuxQueuedMessage = {
  id: string;
  target: string;
  agent: string;
  text: string;
  enter: boolean;
  submitKey: TmuxSubmitKey;
  label?: string;
  queuedAtMs: number;
};

// When atw last typed into a held pane, and whether that turn has been seen running since.
export type TmuxSendTrack = { sentAtMs: number; sawWorking: boolean };

export type TmuxSendRequest = {
  target: string;
  text: string;
  enter: boolean;
  submitKey: TmuxSubmitKey;
  label?: string | null;
};

// Whether a pane whose agent drops type-ahead can take the next message now.
export function paneReadyForInput(
  row: AgentRow | undefined,
  snapshotEpochSec: number,
  track: TmuxSendTrack | undefined,
  settleMs = SEND_SETTLE_MS
): boolean {
  if (!row || !READY_STATES.has(row.status)) {
    return false;
  }
  if (!track || track.sawWorking) {
    return true;
  }
  // idle_since resets on any non-quiet state, so a newer one means a turn ended after the send.
  if (row.idleSinceSec !== undefined && row.idleSinceSec * 1000 > track.sentAtMs) {
    return true;
  }
  // A turn too short for any snapshot to catch still leaves the pane ready well after the send.
  return snapshotEpochSec * 1000 - track.sentAtMs >= settleMs;
}

export function toTmuxQueuedMessageDto(message: TmuxQueuedMessage): TmuxQueuedMessageDto {
  return { id: message.id, text: message.text, agent: message.agent, queuedAtMs: message.queuedAtMs };
}

export function parseTmuxSendQueueFile(serialized: string): { messages: TmuxQueuedMessage[]; sent: Map<string, TmuxSendTrack> } {
  const empty = { messages: [], sent: new Map<string, TmuxSendTrack>() };
  let document: unknown;
  try {
    document = JSON.parse(serialized);
  } catch {
    return empty;
  }
  if (!isRecord(document) || document.version !== FILE_VERSION) {
    return empty;
  }
  const messages = Array.isArray(document.messages) ? document.messages.flatMap((entry) => {
    const message = parseMessage(entry);
    return message ? [message] : [];
  }) : [];
  const sent = new Map<string, TmuxSendTrack>();
  if (isRecord(document.sent)) {
    for (const [target, track] of Object.entries(document.sent)) {
      if (target && isRecord(track) && typeof track.sentAtMs === "number" && Number.isFinite(track.sentAtMs)) {
        sent.set(target, { sentAtMs: track.sentAtMs, sawWorking: track.sawWorking === true });
      }
    }
  }
  return { messages, sent };
}

function parseMessage(entry: unknown): TmuxQueuedMessage | null {
  if (!isRecord(entry)) {
    return null;
  }
  const { id, target, agent, text, enter, submitKey, label, queuedAtMs } = entry;
  if (typeof id !== "string" || !id || typeof target !== "string" || !target || typeof agent !== "string" || typeof text !== "string" || !text
    || typeof queuedAtMs !== "number" || !Number.isFinite(queuedAtMs) || typeof submitKey !== "string" || !SUBMIT_KEYS.has(submitKey)) {
    return null;
  }
  return {
    id,
    target,
    agent,
    text,
    enter: enter !== false,
    submitKey: submitKey as TmuxSubmitKey,
    ...(typeof label === "string" && label ? { label } : {}),
    queuedAtMs
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export type TmuxSendQueueOptions = {
  filePath: string | null;
  // agent-status rows, or null while its snapshot is stale.
  readRows: () => Promise<AgentRowsSnapshot | null>;
  // Types the text literally, then submits it with a separate key when enter is set.
  typeText: (target: string, text: string, enter: boolean, submitKey: TmuxSubmitKey) => Promise<void>;
  onDelivered?: (message: TmuxQueuedMessage) => void;
  onError?: (error: unknown) => void;
  now?: () => number;
  newId?: () => string;
  settleMs?: number;
};

// Holds text for panes whose agent drops input typed mid-turn and types it once the turn ends, oldest first.
export class TmuxSendQueue {
  private messages: TmuxQueuedMessage[] = [];
  private sent = new Map<string, TmuxSendTrack>();
  private lock: Promise<unknown> = Promise.resolve();
  private writing: Promise<void> = Promise.resolve();
  private timer: NodeJS.Timeout | null = null;
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly settleMs: number;

  constructor(private readonly options: TmuxSendQueueOptions) {
    this.now = options.now ?? Date.now;
    this.newId = options.newId ?? randomUUID;
    this.settleMs = options.settleMs ?? SEND_SETTLE_MS;
  }

  async load(): Promise<void> {
    if (!this.options.filePath) {
      return;
    }
    const serialized = await readFile(this.options.filePath, "utf8").catch(() => "");
    const loaded = parseTmuxSendQueueFile(serialized);
    const known = new Set(this.messages.map((message) => message.id));
    this.messages = [...loaded.messages.filter((message) => !known.has(message.id)), ...this.messages];
    for (const [target, track] of loaded.sent) {
      if (!this.sent.has(target)) {
        this.sent.set(target, track);
      }
    }
  }

  start(intervalMs = SEND_QUEUE_TICK_MS): void {
    if (this.timer) {
      return;
    }
    this.timer = setInterval(() => {
      this.tick().catch((error: unknown) => this.options.onError?.(error));
    }, intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  // Types the text now, or holds it (returning the held message) while the pane's agent would drop it.
  send(request: TmuxSendRequest): Promise<TmuxQueuedMessage | null> {
    return this.exclusive(async () => {
      const snapshot = await this.options.readRows();
      const row = snapshot?.rows.get(request.target);
      const waiting = this.messages.some((message) => message.target === request.target);
      if (!waiting && (!snapshot || !row || !tmuxAgentDropsTypeAhead(row.kind))) {
        await this.options.typeText(request.target, request.text, request.enter, request.submitKey);
        return null;
      }
      if (snapshot) {
        this.observe(snapshot);
      }
      if (!waiting && snapshot && paneReadyForInput(row, snapshot.epochSec, this.sent.get(request.target), this.settleMs)) {
        await this.options.typeText(request.target, request.text, request.enter, request.submitKey);
        this.sent.set(request.target, { sentAtMs: this.now(), sawWorking: false });
        this.persist();
        return null;
      }
      const message: TmuxQueuedMessage = {
        id: this.newId(),
        target: request.target,
        agent: row?.kind ?? this.messages.find((entry) => entry.target === request.target)?.agent ?? "agent",
        text: request.text,
        enter: request.enter,
        submitKey: request.submitKey,
        ...(request.label ? { label: request.label } : {}),
        queuedAtMs: this.now()
      };
      this.messages.push(message);
      this.persist();
      return message;
    });
  }

  list(target?: string): TmuxQueuedMessage[] {
    return this.messages.filter((message) => target === undefined || message.target === target);
  }

  cancel(id: string): boolean {
    const before = this.messages.length;
    this.messages = this.messages.filter((message) => message.id !== id);
    if (this.messages.length === before) {
      return false;
    }
    this.persist();
    return true;
  }

  // The pane is gone, so nothing held for it can be delivered.
  clearTarget(target: string): void {
    const before = this.messages.length;
    this.messages = this.messages.filter((message) => message.target !== target);
    const hadTrack = this.sent.delete(target);
    if (hadTrack || this.messages.length !== before) {
      this.persist();
    }
  }

  // Delivers at most one held message per pane whose turn has ended since atw last typed into it.
  tick(): Promise<void> {
    if (this.messages.length === 0 && this.sent.size === 0) {
      return Promise.resolve();
    }
    return this.exclusive(async () => {
      const snapshot = await this.options.readRows();
      if (!snapshot) {
        return;
      }
      let changed = this.observe(snapshot);
      const targets = [...new Set(this.messages.map((message) => message.target))];
      for (const target of targets) {
        const row = snapshot.rows.get(target);
        if (!row || !tmuxAgentDropsTypeAhead(row.kind) || !paneReadyForInput(row, snapshot.epochSec, this.sent.get(target), this.settleMs)) {
          continue;
        }
        const next = this.messages.find((message) => message.target === target);
        if (!next) {
          continue;
        }
        try {
          await this.options.typeText(next.target, next.text, next.enter, next.submitKey);
        } catch (error) {
          // Left at the head of the queue for the next tick.
          this.options.onError?.(error);
          continue;
        }
        this.messages = this.messages.filter((message) => message.id !== next.id);
        this.sent.set(target, { sentAtMs: this.now(), sawWorking: false });
        changed = true;
        this.options.onDelivered?.(next);
      }
      // Settled panes with nothing waiting need no tracking.
      for (const [target, track] of this.sent) {
        if (!this.messages.some((message) => message.target === target)
          && paneReadyForInput(snapshot.rows.get(target), snapshot.epochSec, track, this.settleMs)) {
          this.sent.delete(target);
          changed = true;
        }
      }
      if (changed) {
        this.persist();
      }
    });
  }

  async flush(): Promise<void> {
    await this.writing;
  }

  // Marks tracked sends whose turn a snapshot taken after them shows running; drops stale tracking.
  private observe(snapshot: AgentRowsSnapshot): boolean {
    let changed = false;
    const nowMs = this.now();
    for (const [target, track] of this.sent) {
      if (nowMs - track.sentAtMs > SEND_TRACK_TTL_MS) {
        this.sent.delete(target);
        changed = true;
        continue;
      }
      if (!track.sawWorking && snapshot.epochSec * 1000 >= track.sentAtMs && snapshot.rows.get(target)?.status === "working") {
        track.sawWorking = true;
        changed = true;
      }
    }
    return changed;
  }

  private exclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = this.lock.then(task, task);
    this.lock = run.catch(() => undefined);
    return run;
  }

  private persist(): void {
    const filePath = this.options.filePath;
    if (!filePath) {
      return;
    }
    const serialized = JSON.stringify({
      version: FILE_VERSION,
      messages: this.messages,
      sent: Object.fromEntries(this.sent)
    });
    this.writing = this.writing.then(async () => {
      await mkdir(path.dirname(filePath), { recursive: true });
      const temporaryPath = `${filePath}.${process.pid}.tmp`;
      await writeFile(temporaryPath, serialized);
      await rename(temporaryPath, filePath);
    }).catch((error: unknown) => this.options.onError?.(error));
  }
}

export type TmuxSendRouterOptions = {
  queue: TmuxSendQueue;
  resolveSubmitKey: (session: string, requested: unknown) => Promise<TmuxSubmitKey>;
  // Key-strip keys (Esc, Ctrl-C, arrows) go straight to the pane, never through the queue.
  sendKey: (session: string, key: string) => Promise<void>;
  onInput?: (session: string) => void;
  // Text with Enter was typed now, not held.
  onSubmitted?: (session: string, label: string | null) => void;
};

export function createTmuxSendRouter({ queue, resolveSubmitKey, sendKey, onInput, onSubmitted }: TmuxSendRouterOptions): Router {
  const router = Router();

  router.post("/api/tmux/send", handle(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const session = requireText(body.session, "session");
    const text = requireText(body.text, "text");
    const enter = body.enter !== false;
    const label = typeof body.label === "string" && body.label.trim() ? body.label.trim() : null;
    onInput?.(session);
    const queued = await queue.send({
      target: session,
      text,
      enter,
      submitKey: enter ? await resolveSubmitKey(session, body.submitKey) : "enter",
      label
    });
    if (!queued && enter) {
      onSubmitted?.(session, label);
    }
    res.json({ ok: true, ...(queued ? { queued: toTmuxQueuedMessageDto(queued) } : {}) } satisfies TmuxSendResultDto);
  }));

  router.post("/api/tmux/keys", handle(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const session = requireText(body.session, "session");
    await sendKey(session, typeof body.key === "string" ? body.key : "");
    onInput?.(session);
    res.json({ ok: true });
  }));

  router.get("/api/tmux/queue", (req, res) => {
    const session = typeof req.query.session === "string" && req.query.session ? req.query.session : undefined;
    res.json({ data: queue.list(session).map(toTmuxQueuedMessageDto) });
  });

  router.delete("/api/tmux/queue/:id", (req, res) => {
    res.json({ ok: true, cancelled: queue.cancel(String(req.params.id)) });
  });

  return router;
}

function requireText(value: unknown, name: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) {
    throw new TmuxRequestError(`Missing required field: ${name}`);
  }
  return text;
}

function handle(handler: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    handler(req, res).catch(next);
  };
}
