import { mkdtemp, readFile, rm } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import express, { type NextFunction, type Request, type Response } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FeedbackLog } from "../feedbackLog.js";
import type { TmuxSession } from "../tmux.js";
import {
  buildTmuxFeedbackText,
  createTmuxFeedbackRouter,
  flattenFeedbackText,
  resolveFeedbackPane,
  type TmuxFeedbackRouterOptions
} from "../tmuxFeedback.js";
import type { TmuxQueuedMessage } from "../tmuxSendQueue.js";

const pane = (name: string, displayName: string, currentCommand = "claude"): TmuxSession => ({
  name,
  displayName,
  windows: 1,
  created: "",
  attached: false,
  clientCount: 0,
  currentCommand
});

describe("resolveFeedbackPane", () => {
  const panes = [pane("%1", "Brief"), pane("%2", "atw"), pane("%3", "Chat")];

  it("matches the Atw display name case-insensitively", () => {
    expect(resolveFeedbackPane(panes).name).toBe("%2");
  });

  it("lets an override name a pane by target or display name", () => {
    expect(resolveFeedbackPane(panes, "%3").name).toBe("%3");
    expect(resolveFeedbackPane(panes, "brief").name).toBe("%1");
    expect(resolveFeedbackPane(panes, "  ").name).toBe("%2");
  });

  it("errors instead of guessing when nothing or several panes match", () => {
    expect(() => resolveFeedbackPane([pane("%1", "Brief")])).toThrow(/No pane named "Atw"/);
    expect(() => resolveFeedbackPane(panes, "nope")).toThrow(/No pane named "nope"/);
    expect(() => resolveFeedbackPane([pane("%1", "Atw"), pane("%2", "ATW")])).toThrow(/2 panes are named "Atw"/);
  });
});

describe("feedback text", () => {
  it("flattens control characters and caps the length", () => {
    expect(flattenFeedbackText("a\nb\r\n\tc\u202ed", 100)).toBe("a b cd");
    expect(flattenFeedbackText("a\nb\r\n\tc\u202ed", 100)).toBe("a b cd");
    expect(flattenFeedbackText(42, 3)).toBe("");
  });

  it("puts the message, context and screenshot path on one line", () => {
    expect(buildTmuxFeedbackText("button is off", { pane: "Atw", view: "TTY", viewport: "390x844", build: "index-ab12.js" }, "~/.agent-tmux/attachments/2026-10-22/s.png"))
      .toBe("Feedback from the Agent Tmux web UI: button is off (pane Atw, view TTY, viewport 390x844, build index-ab12.js) Screenshot: ~/.agent-tmux/attachments/2026-10-22/s.png");
    expect(buildTmuxFeedbackText("hi", {}, "")).toBe("Feedback from the Agent Tmux web UI: hi");
    expect(buildTmuxFeedbackText("hi", { view: "TTY", screenshotError: "Screenshot timed out" }, ""))
      .toBe("Feedback from the Agent Tmux web UI: hi (view TTY, screenshot failed Screenshot timed out)");
  });
});

describe("tmux feedback endpoint", () => {
  let server: http.Server;
  let baseUrl = "";
  let sent: Array<{ target: string; text: string; hold?: boolean }> = [];
  let recorded: string[] = [];
  let override: string | undefined;
  let held: TmuxQueuedMessage | null = null;
  let sendError: Error | null = null;
  let panes: TmuxSession[] = [];
  let startCalls = 0;
  let readyResult: ((value: boolean) => void) | null = null;
  let logDir = "";
  let logFile = "";
  let log: FeedbackLog;
  const PANES = [pane("%1", "Brief"), pane("%2", "Atw"), pane("%3", "Shell", "zsh"), pane("%4", "Plain")];
  const AGENTS = new Map([["%1", "claude"], ["%2", "claude"], ["%9", "claude"]]);

  async function listen(extra: Partial<TmuxFeedbackRouterOptions> = {}): Promise<void> {
    const app = express();
    app.use(express.json());
    app.use(createTmuxFeedbackRouter({
      listPanes: async () => panes,
      readPaneAgents: async (panes) => new Map(panes.flatMap((entry) => AGENTS.has(entry.name) ? [[entry.name, AGENTS.get(entry.name)!] as const] : [])),
      send: async (target, text, options) => {
        if (sendError) {
          throw sendError;
        }
        sent.push({ target, text, ...(options?.hold ? { hold: true } : {}) });
        return held;
      },
      log,
      paneOverride: () => override,
      onSubmitted: (target) => recorded.push(target),
      startPane: async () => {
        startCalls += 1;
        return { pane: "%9", ready: new Promise<boolean>((resolve) => { readyResult = resolve; }) };
      },
      ...extra
    }));
    app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
      const record = error as { statusCode?: number; message?: string };
      res.status(record.statusCode ?? 500).json({ error: record.message });
    });
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  async function relisten(extra: Partial<TmuxFeedbackRouterOptions>): Promise<void> {
    await new Promise((resolve) => server.close(resolve));
    await listen(extra);
  }

  // The log as [id, outcome or message] pairs, in file order.
  async function logged(): Promise<Array<[string, string]>> {
    await log.flush();
    const serialized = await readFile(logFile, "utf8").catch(() => "");
    return serialized.trim().split("\n").filter(Boolean).map((line) => {
      const entry = JSON.parse(line) as { id: string; outcome?: string; message?: string };
      return [entry.id, entry.outcome ?? `submitted: ${entry.message}`];
    });
  }

  beforeEach(async () => {
    sent = [];
    recorded = [];
    override = undefined;
    held = null;
    sendError = null;
    panes = PANES;
    startCalls = 0;
    readyResult = null;
    logDir = await mkdtemp(path.join(tmpdir(), "atw-feedback-"));
    logFile = path.join(logDir, "atw", "feedback.jsonl");
    let ids = 0;
    log = new FeedbackLog({ filePath: logFile, newId: () => `f${++ids}` });
    await listen();
  });

  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
    await log.flush();
    await rm(logDir, { recursive: true, force: true });
  });

  async function post(body: unknown) {
    const response = await fetch(`${baseUrl}/api/tmux/feedback`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    return { status: response.status, json: await response.json() as Record<string, unknown> };
  }

  it("types the feedback into the Atw pane", async () => {
    const result = await post({
      message: "line one\nline two",
      screenshot: "~/.agent-tmux/attachments/2026-10-22/shot.png",
      context: { pane: "Brief", view: "TTY", viewport: "390x844", build: "index-1.js" }
    });
    expect(result.status).toBe(200);
    expect(result.json.data).toEqual({ target: "%2", paneName: "Atw" });
    expect(sent).toEqual([{
      target: "%2",
      text: "Feedback from the Agent Tmux web UI: line one line two (pane Brief, view TTY, viewport 390x844, build index-1.js) Screenshot: ~/.agent-tmux/attachments/2026-10-22/shot.png"
    }]);
    expect(recorded).toEqual(["%2"]);
    expect(await logged()).toEqual([["f1", "submitted: line one line two"], ["f1", "delivered"]]);
    const [submission] = (await readFile(logFile, "utf8")).split("\n").map((line) => line && JSON.parse(line) as Record<string, unknown>);
    expect(submission).toMatchObject({
      id: "f1",
      target: "%2",
      text: sent[0].text,
      screenshot: "~/.agent-tmux/attachments/2026-10-22/shot.png",
      context: { pane: "Brief", view: "TTY", viewport: "390x844", build: "index-1.js" }
    });
    expect(Number.isFinite(Date.parse(String((submission as Record<string, unknown>).at)))).toBe(true);
  });

  it("logs a send that fails as undelivered and still answers with the error", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      sendError = new Error("can't find pane: %2");
      const result = await post({ message: "lost?" });
      expect(result.status).toBe(500);
      expect(await logged()).toEqual([["f1", "submitted: lost?"], ["f1", "undelivered"]]);
      expect(error).toHaveBeenCalledWith(expect.stringContaining("can't find pane: %2"));
    } finally {
      error.mockRestore();
    }
  });

  it("follows ATW_FEEDBACK_PANE", async () => {
    override = "%1";
    expect((await post({ message: "hi" })).json.data).toMatchObject({ target: "%1" });
  });

  it("reports a held message and does not mark input", async () => {
    held = { id: "q1", target: "%2", agent: "claude", text: "x", enter: true, submitKey: "enter", queuedAtMs: 1 } as TmuxQueuedMessage;
    const result = await post({ message: "hi" });
    expect(result.status).toBe(200);
    expect(result.json.data).toMatchObject({ target: "%2", queued: { id: "q1" } });
    expect(recorded).toEqual([]);
    expect(await logged()).toEqual([["f1", "submitted: hi"], ["f1", "queued"]]);
  });

  it("rejects instead of guessing another pane", async () => {
    override = "Missing";
    const missing = await post({ message: "hi" });
    expect(missing.status).toBe(400);
    expect(String(missing.json.error)).toContain('No pane named "Missing"');
    override = "%3";
    const shell = await post({ message: "hi" });
    expect(shell.status).toBe(400);
    expect(String(shell.json.error)).toContain("not running an agent");
    expect(sent).toEqual([]);
  });

  it("rejects empty messages and foreign screenshot paths", async () => {
    expect((await post({ message: "  " })).status).toBe(400);
    expect((await post({ message: "hi", screenshot: "/etc/passwd" })).status).toBe(400);
    expect((await post({ message: "hi", screenshot: "~/.agent-tmux/attachments/../x" })).status).toBe(400);
    expect(sent).toEqual([]);
    expect(await logged()).toEqual([]);
  });

  describe("with no Atw pane", () => {
    beforeEach(() => {
      panes = PANES.filter((entry) => entry.displayName !== "Atw");
    });

    it("starts Atw, answers at once, and types only after it is ready", async () => {
      const result = await post({ message: "hi" });
      expect(result.status).toBe(200);
      expect(result.json.data).toEqual({ target: "%9", paneName: "Atw", started: true });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(sent).toEqual([]);
      readyResult!(true);
      await vi.waitFor(() => expect(sent).toEqual([{ target: "%9", text: "Feedback from the Agent Tmux web UI: hi" }]));
      await vi.waitFor(async () => expect(await logged()).toEqual([["f1", "submitted: hi"], ["f1", "delivered"]]));
      expect(recorded).toEqual(["%9"]);
      expect(startCalls).toBe(1);
    });

    it("logs the submission before the new session is ready", async () => {
      await post({ message: "early" });
      expect(await logged()).toEqual([["f1", "submitted: early"]]);
    });

    it("hands a ready session to the verified fresh delivery and logs its outcome", async () => {
      const fresh: Array<{ pane: string; text: string }> = [];
      await relisten({
        deliverFresh: async (pane, text) => {
          fresh.push({ pane, text });
          return { outcome: "retried" };
        }
      });
      await post({ message: "swallowed once" });
      readyResult!(true);
      await vi.waitFor(async () => expect(await logged()).toEqual([["f1", "submitted: swallowed once"], ["f1", "retried"]]));
      expect(fresh).toEqual([{ pane: "%9", text: "Feedback from the Agent Tmux web UI: swallowed once" }]);
      expect(sent).toEqual([]);
      expect(recorded).toEqual(["%9"]);
    });

    it("runs fresh deliveries one at a time and does not mark input for an undelivered one", async () => {
      const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
      try {
        let active = 0;
        let overlapped = false;
        await relisten({
          deliverFresh: async (_pane, text) => {
            active += 1;
            overlapped ||= active > 1;
            await new Promise((resolve) => setTimeout(resolve, 10));
            active -= 1;
            if (text.endsWith("one")) {
              return { outcome: "undelivered", reason: "not seen landing and no transcript to check" };
            }
            throw new Error("tmux went away");
          }
        });
        await post({ message: "one" });
        await post({ message: "two" });
        readyResult!(true);
        await vi.waitFor(async () => expect((await logged()).filter(([, value]) => value === "undelivered")).toHaveLength(2));
        expect(overlapped).toBe(false);
        expect(recorded).toEqual([]);
        expect(error).toHaveBeenCalledWith(expect.stringContaining("tmux went away"));
      } finally {
        error.mockRestore();
      }
    });

    it("shares one in-flight start between posts", async () => {
      const first = await post({ message: "one" });
      const second = await post({ message: "two" });
      expect(first.json.data).toMatchObject({ target: "%9", started: true });
      expect(second.json.data).toMatchObject({ target: "%9", started: true });
      expect(startCalls).toBe(1);
      readyResult!(true);
      await vi.waitFor(() => expect(sent).toHaveLength(2));
      expect(sent.map((entry) => entry.target)).toEqual(["%9", "%9"]);
      expect(sent.map((entry) => entry.text).sort()).toEqual([
        "Feedback from the Agent Tmux web UI: one",
        "Feedback from the Agent Tmux web UI: two"
      ]);
    });

    it("holds the feedback in the send queue instead of dropping it when the agent never reads ready", async () => {
      held = { id: "q1", target: "%9", agent: "claude", text: "x", enter: true, submitKey: "enter", hold: true, queuedAtMs: 1 };
      const result = await post({ message: "busy" });
      expect(result.status).toBe(200);
      readyResult!(false);
      await vi.waitFor(() => expect(sent).toEqual([{ target: "%9", text: "Feedback from the Agent Tmux web UI: busy", hold: true }]));
      await vi.waitFor(async () => expect(await logged()).toEqual([["f1", "submitted: busy"], ["f1", "queued"]]));
      expect(recorded).toEqual([]);
    });

    it("keeps refusing when an override is set", async () => {
      override = "Missing";
      const result = await post({ message: "hi" });
      expect(result.status).toBe(400);
      expect(String(result.json.error)).toContain('No pane named "Missing"');
      expect(startCalls).toBe(0);
    });

    it("uses the new pane normally once it is visible and ready", async () => {
      await post({ message: "first" });
      readyResult!(true);
      await vi.waitFor(() => expect(sent).toHaveLength(1));
      panes = [...panes, pane("%9", "Atw")];
      const later = await post({ message: "second" });
      expect(later.json.data).toEqual({ target: "%9", paneName: "Atw" });
      expect(startCalls).toBe(1);
      expect(sent.map((entry) => entry.target)).toEqual(["%9", "%9"]);
    });
  });
});
