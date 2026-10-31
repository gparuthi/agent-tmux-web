import { Router, type NextFunction, type Request, type Response } from "express";

import type { TmuxFeedbackResultDto } from "../shared/api.js";
import type { FeedbackDeliveryResult, FeedbackLog, FeedbackLogEntry } from "./feedbackLog.js";
import { TmuxRequestError, type TmuxSession } from "./tmux.js";
import { toTmuxQueuedMessageDto, type TmuxQueuedMessage } from "./tmuxSendQueue.js";

// The pane whose display name is this receives the feedback, unless ATW_FEEDBACK_PANE says otherwise.
export const DEFAULT_FEEDBACK_PANE_NAME = "Atw";
export const FEEDBACK_MESSAGE_MAX_LENGTH = 4000;
const CONTEXT_VALUE_MAX_LENGTH = 120;
// The only shape /api/uploads hands out; anything else is not a path atw wrote.
const ATTACHMENT_REFERENCE_PATTERN = /^~\/\.agent-tmux\/attachments\/[\w.-]+\/[\w.-]+$/;
const CONTROL_PATTERN = /[\p{Cc}\u2028\u2029]+/gu;
const BIDI_CONTROL_PATTERN = /[\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu;

export type TmuxFeedbackContext = {
  pane?: string;
  view?: string;
  viewport?: string;
  build?: string;
  screenshotError?: string;
};

export type TmuxFeedbackRouterOptions = {
  listPanes: () => Promise<TmuxSession[]>;
  readPaneAgents: (panes: TmuxSession[]) => Promise<Map<string, string>>;
  // Types the text and Enter now, or holds it (returning the held message) while the agent is mid-turn;
  // with hold it waits until the pane reads at a prompt whatever the agent.
  send: (target: string, text: string, options?: { hold?: boolean }) => Promise<TmuxQueuedMessage | null>;
  // Every accepted submission is written here before anything is typed.
  log: FeedbackLog;
  // Pane target (%N) or display name from ATW_FEEDBACK_PANE; read per request so it can change live.
  paneOverride?: () => string | undefined;
  onSubmitted?: (target: string) => void;
  // Starts the agent that answers atw feedback when no pane is named for it; `ready` resolves true once that agent waits at a prompt.
  startPane?: () => Promise<{ pane: string; ready: Promise<boolean> }>;
  // Types into a pane startPane just readied and checks it landed; without it the text goes through send.
  deliverFresh?: (pane: string, text: string) => Promise<FeedbackDeliveryResult>;
};

// Matches by pane target first, then by display name (case-insensitive); never falls back to another pane.
export function resolveFeedbackPane(panes: TmuxSession[], override?: string): TmuxSession {
  const wanted = override?.trim() || DEFAULT_FEEDBACK_PANE_NAME;
  const byTarget = override?.trim() ? panes.find((pane) => pane.name === wanted) : undefined;
  if (byTarget) {
    return byTarget;
  }
  const lowered = wanted.toLowerCase();
  const matches = panes.filter((pane) => pane.displayName?.trim().toLowerCase() === lowered);
  if (matches.length === 1) {
    return matches[0];
  }
  const hint = "Set ATW_FEEDBACK_PANE to a pane id or name.";
  if (matches.length > 1) {
    throw new TmuxRequestError(`${matches.length} panes are named "${wanted}". ${hint}`);
  }
  throw new TmuxRequestError(`No pane named "${wanted}" to send feedback to. ${hint}`);
}

// One line of printable text: a newline typed into the agent would submit early.
export function flattenFeedbackText(value: unknown, maxLength: number): string {
  if (typeof value !== "string") {
    return "";
  }
  const flat = value.replace(CONTROL_PATTERN, " ").replace(BIDI_CONTROL_PATTERN, "").replace(/\s+/gu, " ").trim();
  return Array.from(flat).slice(0, maxLength).join("").trim();
}

export function buildTmuxFeedbackText(message: string, context: TmuxFeedbackContext, screenshot: string): string {
  const details = [
    ["pane", context.pane],
    ["view", context.view],
    ["viewport", context.viewport],
    ["build", context.build],
    ["screenshot failed", context.screenshotError]
  ].flatMap(([key, value]) => value ? [`${key} ${value}`] : []);
  return [
    `Feedback from the Agent Tmux web UI: ${message}`,
    details.length ? `(${details.join(", ")})` : "",
    screenshot ? `Screenshot: ${screenshot}` : ""
  ].filter(Boolean).join(" ");
}

function queuedOrDelivered(queued: TmuxQueuedMessage | null): FeedbackDeliveryResult {
  return { outcome: queued ? "queued" : "delivered" };
}

function errorReason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createTmuxFeedbackRouter({ listPanes, readPaneAgents, send, log, paneOverride, onSubmitted, startPane, deliverFresh }: TmuxFeedbackRouterOptions): Router {
  const router = Router();
  type StartedPane = { pane: string; ready: Promise<boolean> };
  // Set synchronously so two posts racing the launch share one pane; cleared once it settles.
  let starting: Promise<StartedPane> | null = null;
  // One fresh delivery at a time, so two texts never interleave keystrokes or confuse each other's check.
  let freshLane: Promise<unknown> = Promise.resolve();

  function startOrJoin(): Promise<StartedPane> {
    if (!starting) {
      const launch = startPane!();
      starting = launch;
      const clear = () => {
        if (starting === launch) {
          starting = null;
        }
      };
      launch.then((started) => started.ready.then(clear, clear), clear);
    }
    return starting;
  }

  function inFreshLane(task: () => Promise<FeedbackDeliveryResult>): Promise<FeedbackDeliveryResult> {
    const run = freshLane.then(task, task);
    freshLane = run.catch(() => undefined);
    return run;
  }

  async function deliverToStarted(entry: StartedPane, text: string): Promise<FeedbackDeliveryResult> {
    // Right after launch the pane runs a shell, so nothing is typed before the agent waits at a prompt.
    if (!await entry.ready.catch(() => false)) {
      // Busy (often the owner typing into it) or never seen ready: the queue types it once the pane reads at a prompt.
      return queuedOrDelivered(await send(entry.pane, text, { hold: true }));
    }
    if (deliverFresh) {
      return inFreshLane(() => deliverFresh(entry.pane, text));
    }
    return queuedOrDelivered(await send(entry.pane, text));
  }

  async function sendWhenReady(entry: StartedPane, record: FeedbackLogEntry): Promise<void> {
    const result = await deliverToStarted(entry, record.text)
      .catch((error: unknown): FeedbackDeliveryResult => ({ outcome: "undelivered", reason: errorReason(error) }));
    await log.outcome(record, result);
    if (result.outcome === "delivered" || result.outcome === "retried") {
      onSubmitted?.(entry.pane);
    }
  }

  async function sendNow(target: string, record: FeedbackLogEntry): Promise<TmuxQueuedMessage | null> {
    let queued: TmuxQueuedMessage | null;
    try {
      queued = await send(target, record.text);
    } catch (error) {
      await log.outcome(record, { outcome: "undelivered", reason: errorReason(error) });
      throw error;
    }
    await log.outcome(record, queuedOrDelivered(queued));
    return queued;
  }

  router.post("/api/tmux/feedback", handle(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const message = flattenFeedbackText(body.message, FEEDBACK_MESSAGE_MAX_LENGTH);
    if (!message) {
      throw new TmuxRequestError("Enter some feedback to send");
    }
    const screenshot = typeof body.screenshot === "string" ? body.screenshot : "";
    if (screenshot && (!ATTACHMENT_REFERENCE_PATTERN.test(screenshot) || screenshot.includes(".."))) {
      throw new TmuxRequestError("Unsupported screenshot reference");
    }
    const rawContext = (body.context && typeof body.context === "object" ? body.context : {}) as Record<string, unknown>;
    const context: TmuxFeedbackContext = {
      pane: flattenFeedbackText(rawContext.pane, CONTEXT_VALUE_MAX_LENGTH),
      view: flattenFeedbackText(rawContext.view, CONTEXT_VALUE_MAX_LENGTH),
      viewport: flattenFeedbackText(rawContext.viewport, CONTEXT_VALUE_MAX_LENGTH),
      build: flattenFeedbackText(rawContext.build, CONTEXT_VALUE_MAX_LENGTH),
      screenshotError: flattenFeedbackText(rawContext.screenshotError, CONTEXT_VALUE_MAX_LENGTH)
    };
    const text = buildTmuxFeedbackText(message, context, screenshot);
    const record = (target: string) => log.record({ target, text, message, context, screenshot });
    const override = paneOverride?.();
    let pane: TmuxSession;
    try {
      pane = resolveFeedbackPane(await listPanes(), override);
    } catch (error) {
      if (!startPane || override?.trim() || !(error instanceof TmuxRequestError) || !error.message.startsWith("No pane named")) {
        throw error;
      }
      const entry = await startOrJoin();
      const logged = await record(entry.pane);
      void sendWhenReady(entry, logged)
        .catch((sendError: unknown) => console.error("Failed to send feedback to the new Atw session", sendError));
      res.json({
        data: { target: entry.pane, paneName: DEFAULT_FEEDBACK_PANE_NAME, started: true } satisfies TmuxFeedbackResultDto
      });
      return;
    }
    // The server's own agent detection decides, so feedback is never typed into a shell.
    const agent = (await readPaneAgents([pane])).get(pane.name) ?? null;
    if (!agent) {
      throw new TmuxRequestError(`The pane "${pane.displayName ?? pane.name}" is not running an agent (${pane.currentCommand ?? "nothing"})`);
    }
    const queued = await sendNow(pane.name, await record(pane.name));
    if (!queued) {
      onSubmitted?.(pane.name);
    }
    res.json({
      data: {
        target: pane.name,
        paneName: pane.displayName ?? pane.name,
        ...(queued ? { queued: toTmuxQueuedMessageDto(queued) } : {})
      } satisfies TmuxFeedbackResultDto
    });
  }));

  return router;
}

function handle(handler: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    handler(req, res).catch(next);
  };
}
