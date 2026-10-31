import { beforeEach, describe, expect, it } from "vitest";

import type { TmuxSessionStatusKind } from "../../shared/api.js";
import {
  deliverToFreshPane,
  FRESH_STABLE_POLL_MS,
  FRESH_STABLE_POLLS,
  FRESH_STABLE_TIMEOUT_MS,
  inputHoldsText,
  pendingInputText,
  planRetry,
  type FreshPaneDeliveryOptions
} from "../feedbackDelivery.js";
import type { TmuxQueuedMessage } from "../tmuxSendQueue.js";

const START_MS = 1_793_484_287_000;
const TEXT = "Feedback from the Agent Tmux web UI: the Fit button overlaps the key strip on a phone (view TTY, viewport 390x844)";
const RULE = "─".repeat(60);

// Claude Code's screen: history, then the input box between two rules, then its footer.
function screen(input: string, history: string[] = []): string {
  return [" ▐▛███▜▌   Claude Code v2.1.300", "", ...history, "", RULE, `❯ ${input}`, RULE, "  ⏵⏵ bypass permissions on (shift+tab to cycle)"].join("\n");
}

// A fake fresh Claude pane: tests script its status per poll and what typing does.
class World {
  nowMs = START_MS;
  status: TmuxSessionStatusKind = "idle";
  // Prompts in the transcript; null when there is no transcript to check.
  transcript: string[] | null = [];
  screen = screen("Try \"fix lint errors\"");
  events: string[] = [];
  typedAtMs: number[] = [];
  held: TmuxQueuedMessage | null = { id: "q1", target: "%9", agent: "claude", text: TEXT, enter: true, submitKey: "enter", hold: true, queuedAtMs: START_MS };
  polls = 0;
  onPoll: (world: World) => void = () => undefined;
  onType: (world: World, attempt: number) => void = () => undefined;
  onSubmit: (world: World) => void = () => undefined;

  options(): FreshPaneDeliveryOptions {
    return {
      pane: "%9",
      agent: "claude",
      text: TEXT,
      readRows: async () => ({ epochSec: Math.floor(this.nowMs / 1000), rows: new Map([["%9", { paneId: "%9", kind: "claude", status: this.status }]]) }),
      typeText: async (_target, text) => {
        this.events.push("type");
        this.typedAtMs.push(this.nowMs);
        this.onType(this, this.typedAtMs.length);
        expect(text).toBe(TEXT);
      },
      submit: async () => {
        this.events.push("submit");
        this.onSubmit(this);
      },
      capture: async () => this.screen,
      transcriptHasText: async (_target, text) => this.transcript === null ? null : this.transcript.some((entry) => entry.includes(text)),
      hold: async () => {
        this.events.push("hold");
        return this.held;
      },
      now: () => this.nowMs,
      sleep: async (ms) => {
        this.nowMs += ms;
        this.polls += 1;
        this.onPoll(this);
      }
    };
  }

  deliver() {
    return deliverToFreshPane(this.options());
  }
}

describe("reading Claude's input box", () => {
  it("takes the text from the last prompt marker down to the rule, across wrapped lines", () => {
    expect(pendingInputText(screen("Try \"fix lint errors\"", ["❯ an earlier prompt", "⏺ Done."]))).toBe("Try \"fix lint errors\"");
    expect(pendingInputText([RULE, "❯ Feedback from the Agent Tmux web UI: the Fit", "  button overlaps", RULE, "  footer"].join("\n")))
      .toBe("Feedback from the Agent Tmux web UI: the Fit button overlaps");
    expect(pendingInputText(["╭────────╮", "│ > Feedback from the  │", "│   Agent Tmux web UI  │", "╰────────╯"].join("\n")))
      .toBe("Feedback from the Agent Tmux web UI");
    expect(pendingInputText("$ zsh prompt")).toBe("");
  });

  it("finds the feedback waiting in the box, or a folded paste of a long one", () => {
    expect(inputHoldsText(screen(TEXT.slice(0, 90)), TEXT)).toBe(true);
    expect(inputHoldsText(screen(""), TEXT)).toBe(false);
    expect(inputHoldsText(screen("", [`❯ ${TEXT}`]), TEXT)).toBe(false);
    const long = `${TEXT} ${"x".repeat(900)}`;
    expect(inputHoldsText(screen("[Pasted text #1 +0 lines]"), long)).toBe(true);
    expect(inputHoldsText(screen("[Pasted text #1 +0 lines]"), TEXT)).toBe(false);
  });

  it("retries only on positive evidence the text did not land", () => {
    expect(planRetry(screen(TEXT), TEXT, null, false)).toEqual({ action: "submit" });
    expect(planRetry(screen("Try \"fix lint errors\""), TEXT, false, false)).toEqual({ action: "retype" });
    expect(planRetry(screen(""), TEXT, false, false)).toEqual({ action: "retype" });
    expect(planRetry(screen(""), TEXT, false, true)).toEqual({ action: "hold" });
    expect(planRetry(screen(""), TEXT, null, false)).toMatchObject({ action: "none" });
    expect(planRetry(screen("", [`❯ ${TEXT}`]), TEXT, false, false)).toMatchObject({ action: "none" });
    expect(planRetry(screen("my own half-typed note"), TEXT, false, false)).toMatchObject({ action: "none", reason: "the input box holds other text" });
  });
});

describe("delivering to a fresh pane", () => {
  let world: World;

  beforeEach(() => {
    world = new World();
  });

  it("waits for the prompt to hold idle before typing, and is done once the transcript has the text", async () => {
    world.onType = (current) => current.transcript!.push(TEXT);
    expect(await world.deliver()).toEqual({ outcome: "delivered" });
    expect(world.events).toEqual(["type"]);
    expect(world.typedAtMs).toEqual([START_MS + FRESH_STABLE_POLLS * FRESH_STABLE_POLL_MS]);
  });

  it("restarts the stable window when the prompt goes busy in between", async () => {
    world.onPoll = (current) => {
      current.status = current.polls === 1 ? "working" : "idle";
    };
    world.onType = (current) => current.transcript!.push(TEXT);
    expect(await world.deliver()).toEqual({ outcome: "delivered" });
    expect(world.typedAtMs).toEqual([START_MS + 3 * FRESH_STABLE_POLL_MS]);
  });

  it("hands the text to the queue when the new session stays busy", async () => {
    world.status = "working";
    expect(await world.deliver()).toEqual({ outcome: "queued" });
    expect(world.events).toEqual(["hold"]);
    expect(world.nowMs - START_MS).toBeGreaterThanOrEqual(FRESH_STABLE_TIMEOUT_MS);
  });

  it("counts a turn seen running after typing when there is no transcript", async () => {
    world.transcript = null;
    world.onType = (current) => {
      current.status = "working";
    };
    expect(await world.deliver()).toEqual({ outcome: "delivered" });
    expect(world.events).toEqual(["type"]);
  });

  it("sends only the submit key when the text sits unsubmitted in the input box", async () => {
    world.onType = (current) => {
      current.screen = screen(TEXT);
    };
    world.onSubmit = (current) => current.transcript!.push(TEXT);
    expect(await world.deliver()).toEqual({ outcome: "retried" });
    expect(world.events).toEqual(["type", "submit"]);
  });

  it("retypes once when the keys were swallowed, as on a session still running its start hooks", async () => {
    world.onType = (current, attempt) => {
      if (attempt === 2) {
        current.transcript!.push(TEXT);
      }
    };
    expect(await world.deliver()).toEqual({ outcome: "retried" });
    expect(world.events).toEqual(["type", "type"]);
  });

  it("reports undelivered after one retry rather than typing a third time", async () => {
    expect(await world.deliver()).toEqual({ outcome: "undelivered", reason: "not seen landing after retyping" });
    expect(world.events).toEqual(["type", "type"]);
  });

  it("holds rather than retyping while another prompt, such as the owner's, runs", async () => {
    world.onType = (current) => {
      current.status = "working";
    };
    expect(await world.deliver()).toEqual({ outcome: "queued" });
    expect(world.events).toEqual(["type", "hold"]);
  });

  it("never retries without proof it did not land", async () => {
    world.transcript = null;
    expect(await world.deliver()).toEqual({ outcome: "undelivered", reason: "not seen landing and no transcript to check" });
    expect(world.events).toEqual(["type"]);

    const onScreen = new World();
    onScreen.onType = (current) => {
      current.screen = screen("", [`❯ ${TEXT}`]);
    };
    expect(await onScreen.deliver()).toEqual({ outcome: "undelivered", reason: "on screen but not in the transcript" });
    expect(onScreen.events).toEqual(["type"]);

    const draft = new World();
    draft.screen = screen("my own half-typed note");
    expect(await draft.deliver()).toEqual({ outcome: "undelivered", reason: "the input box holds other text" });
    expect(draft.events).toEqual(["type"]);
  });

  it("is delivered when the transcript shows the text on the last check", async () => {
    world.onPoll = (current) => {
      if (current.typedAtMs.length && current.nowMs - current.typedAtMs[0] >= 10_000) {
        current.transcript!.push(TEXT);
      }
    };
    expect(await world.deliver()).toEqual({ outcome: "delivered" });
    expect(world.events).toEqual(["type"]);
  });
});
