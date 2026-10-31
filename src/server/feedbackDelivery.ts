import type { AgentRowsSnapshot } from "./agentRows.js";
import { isAtAgentPrompt } from "./agentStartName.js";
import type { FeedbackDeliveryResult } from "./feedbackLog.js";
import type { TmuxQueuedMessage } from "./tmuxSendQueue.js";

// A fresh Claude can read idle while SessionStart hooks still run and swallow keys, so the prompt must hold this long first.
export const FRESH_STABLE_POLL_MS = 1500;
export const FRESH_STABLE_POLLS = 2;
export const FRESH_STABLE_TIMEOUT_MS = 30_000;
export const FRESH_VERIFY_POLL_MS = 1000;
export const FRESH_VERIFY_TIMEOUT_MS = 10_000;
// Enough of the text's start to tell it apart on screen; every feedback line opens with the same 30 characters.
const SCREEN_MATCH_CHARS = 60;
// Claude Code folds a paste this long into a "[Pasted text #1]" placeholder in its input box.
const PASTE_FOLD_MIN_CHARS = 800;
const PROMPT_LINE = /^\s*│?\s*[❯>]\s?(.*)$/u;
// Claude Code's input box ends at a ─── rule (or the ╰───╯ bottom of its older box).
const RULE_LINE = /^\s*[─━╰]{2,}/u;
// The dimmed suggestion an empty Claude Code prompt shows, read as plain text by capture-pane.
const PROMPT_SUGGESTION = /^Try "/u;

export type FreshPaneDeliveryOptions = {
  pane: string;
  agent: string;
  text: string;
  readRows: () => Promise<AgentRowsSnapshot | null>;
  // Types the text, then its submit key.
  typeText: (target: string, text: string) => Promise<void>;
  // Sends only the submit key.
  submit: (target: string) => Promise<void>;
  // Scrollback and the visible pane as plain text.
  capture: (target: string) => Promise<string>;
  // Whether the agent's own transcript recorded the text; null when there is none to check.
  transcriptHasText: (target: string, text: string) => Promise<boolean | null>;
  // Hands the text to the send queue, held until the pane reads at a prompt; null when it was typed at once.
  hold: (target: string, text: string) => Promise<TmuxQueuedMessage | null>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  stablePollMs?: number;
  stablePolls?: number;
  stableTimeoutMs?: number;
  verifyPollMs?: number;
  verifyTimeoutMs?: number;
};

type Resolved = Required<FreshPaneDeliveryOptions>;

export type RetryPlan = { action: "submit" | "retype" | "hold" } | { action: "none"; reason: string };

// The text in the agent's input box: from the last prompt marker down to the rule under it.
export function pendingInputText(capture: string): string {
  const lines = capture.split("\n");
  let start = lines.length - 1;
  while (start >= 0 && !PROMPT_LINE.test(lines[start])) {
    start -= 1;
  }
  if (start < 0) {
    return "";
  }
  const parts = [lines[start].match(PROMPT_LINE)?.[1] ?? ""];
  for (let index = start + 1; index < lines.length && !RULE_LINE.test(lines[index]); index += 1) {
    parts.push(lines[index]);
  }
  return parts.map((part) => part.replace(/│/gu, " ").trim()).filter(Boolean).join(" ");
}

function squash(value: string): string {
  return value.replace(/[\s│]+/gu, "");
}

function screenKey(text: string): string {
  return squash(text).slice(0, SCREEN_MATCH_CHARS);
}

export function inputHoldsText(capture: string, text: string): boolean {
  const pending = pendingInputText(capture);
  return squash(pending).includes(screenKey(text)) || (text.length >= PASTE_FOLD_MIN_CHARS && /\[Pasted text #\d+/u.test(pending));
}

export function screenShowsText(capture: string, text: string): boolean {
  return squash(capture).includes(screenKey(text));
}

// Retries only on positive evidence the text did not land, so nothing is ever submitted twice.
export function planRetry(capture: string, text: string, inTranscript: boolean | null, working: boolean): RetryPlan {
  if (inputHoldsText(capture, text)) {
    return { action: "submit" };
  }
  if (inTranscript !== false) {
    return { action: "none", reason: "not seen landing and no transcript to check" };
  }
  if (screenShowsText(capture, text)) {
    return { action: "none", reason: "on screen but not in the transcript" };
  }
  // Another prompt (often the owner's) is running; the queue types it once that turn ends.
  if (working) {
    return { action: "hold" };
  }
  const pending = pendingInputText(capture);
  if (pending && !PROMPT_SUGGESTION.test(pending)) {
    return { action: "none", reason: "the input box holds other text" };
  }
  return { action: "retype" };
}

// Types feedback into a pane that just started and checks it landed, resubmitting or retyping once when it plainly did not.
export async function deliverToFreshPane(input: FreshPaneDeliveryOptions): Promise<FeedbackDeliveryResult> {
  const options: Resolved = {
    now: Date.now,
    sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    stablePollMs: FRESH_STABLE_POLL_MS,
    stablePolls: FRESH_STABLE_POLLS,
    stableTimeoutMs: FRESH_STABLE_TIMEOUT_MS,
    verifyPollMs: FRESH_VERIFY_POLL_MS,
    verifyTimeoutMs: FRESH_VERIFY_TIMEOUT_MS,
    ...input
  };
  if (!await waitForStablePrompt(options)) {
    return holdResult(options);
  }
  await options.typeText(options.pane, options.text);
  if (await landed(options, options.now())) {
    return { outcome: "delivered" };
  }
  const inTranscript = await checkTranscript(options);
  if (inTranscript) {
    return { outcome: "delivered" };
  }
  const capture = await options.capture(options.pane).catch(() => null);
  if (capture === null) {
    return { outcome: "undelivered", reason: "not seen landing and the pane could not be read" };
  }
  const plan = planRetry(capture, options.text, inTranscript, (await options.readRows())?.rows.get(options.pane)?.status === "working");
  if (plan.action === "none") {
    return { outcome: "undelivered", reason: plan.reason };
  }
  if (plan.action === "hold") {
    return holdResult(options);
  }
  await (plan.action === "submit" ? options.submit(options.pane) : options.typeText(options.pane, options.text));
  if (await landed(options, options.now())) {
    return { outcome: "retried" };
  }
  return { outcome: "undelivered", reason: `not seen landing after ${plan.action === "submit" ? "resubmitting" : "retyping"}` };
}

async function holdResult(options: Resolved): Promise<FeedbackDeliveryResult> {
  return { outcome: await options.hold(options.pane, options.text) ? "queued" : "delivered" };
}

// True once the agent has sat at its prompt for consecutive polls; false when it stays busy or never settles.
async function waitForStablePrompt(options: Resolved): Promise<boolean> {
  const deadline = options.now() + options.stableTimeoutMs;
  let streak = 0;
  while (streak < options.stablePolls) {
    if (options.now() >= deadline) {
      return false;
    }
    await options.sleep(options.stablePollMs);
    streak = isAtAgentPrompt((await options.readRows())?.rows.get(options.pane), options.agent) ? streak + 1 : 0;
  }
  return true;
}

// The transcript decides when there is one; otherwise a snapshot taken after typing must show the turn running.
async function landed(options: Resolved, typedAtMs: number): Promise<boolean> {
  const deadline = typedAtMs + options.verifyTimeoutMs;
  while (options.now() < deadline) {
    await options.sleep(options.verifyPollMs);
    const inTranscript = await checkTranscript(options);
    if (inTranscript) {
      return true;
    }
    const snapshot = inTranscript === null ? await options.readRows() : null;
    if (snapshot && snapshot.epochSec * 1000 >= typedAtMs && snapshot.rows.get(options.pane)?.status === "working") {
      return true;
    }
  }
  return false;
}

function checkTranscript(options: Resolved): Promise<boolean | null> {
  return options.transcriptHasText(options.pane, options.text).catch(() => null);
}
