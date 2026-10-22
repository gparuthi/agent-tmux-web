import { Router, type NextFunction, type Request, type Response } from "express";

import type { TmuxFeedbackResultDto } from "../shared/api.js";
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
};

export type TmuxFeedbackRouterOptions = {
  listPanes: () => Promise<TmuxSession[]>;
  readPaneAgents: (panes: TmuxSession[]) => Promise<Map<string, string>>;
  // Types the text and Enter now, or holds it (returning the held message) while the agent is mid-turn.
  send: (target: string, text: string) => Promise<TmuxQueuedMessage | null>;
  // Pane target (%N) or display name from ATW_FEEDBACK_PANE; read per request so it can change live.
  paneOverride?: () => string | undefined;
  onSubmitted?: (target: string) => void;
  // Starts the agent that answers atw feedback when no pane is named for it; `ready` resolves true once that agent waits at a prompt.
  startPane?: () => Promise<{ pane: string; ready: Promise<boolean> }>;
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
    ["build", context.build]
  ].flatMap(([key, value]) => value ? [`${key} ${value}`] : []);
  return [
    `Feedback from the Agent Tmux web UI: ${message}`,
    details.length ? `(${details.join(", ")})` : "",
    screenshot ? `Screenshot: ${screenshot}` : ""
  ].filter(Boolean).join(" ");
}

export function createTmuxFeedbackRouter({ listPanes, readPaneAgents, send, paneOverride, onSubmitted, startPane }: TmuxFeedbackRouterOptions): Router {
  const router = Router();
  type StartedPane = { pane: string; ready: Promise<boolean> };
  // Set synchronously so two posts racing the launch share one pane; cleared once it settles.
  let starting: Promise<StartedPane> | null = null;

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

  async function sendWhenReady(entry: StartedPane, text: string): Promise<void> {
    // Right after launch the pane runs a shell, so nothing is typed before the agent waits at a prompt.
    if (!await entry.ready.catch(() => false)) {
      console.error(`The ${DEFAULT_FEEDBACK_PANE_NAME} session never became ready; feedback dropped: ${text}`);
      return;
    }
    const queued = await send(entry.pane, text);
    if (!queued) {
      onSubmitted?.(entry.pane);
    }
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
      build: flattenFeedbackText(rawContext.build, CONTEXT_VALUE_MAX_LENGTH)
    };
    const override = paneOverride?.();
    let pane: TmuxSession;
    try {
      pane = resolveFeedbackPane(await listPanes(), override);
    } catch (error) {
      if (!startPane || override?.trim() || !(error instanceof TmuxRequestError) || !error.message.startsWith("No pane named")) {
        throw error;
      }
      const entry = await startOrJoin();
      void sendWhenReady(entry, buildTmuxFeedbackText(message, context, screenshot))
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
    const queued = await send(pane.name, buildTmuxFeedbackText(message, context, screenshot));
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
