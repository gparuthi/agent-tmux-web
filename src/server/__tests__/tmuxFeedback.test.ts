import http from "node:http";
import type { AddressInfo } from "node:net";

import express, { type NextFunction, type Request, type Response } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TmuxSession } from "../tmux.js";
import { buildTmuxFeedbackText, createTmuxFeedbackRouter, flattenFeedbackText, resolveFeedbackPane } from "../tmuxFeedback.js";
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
  });
});

describe("tmux feedback endpoint", () => {
  let server: http.Server;
  let baseUrl = "";
  let sent: Array<{ target: string; text: string }> = [];
  let recorded: string[] = [];
  let override: string | undefined;
  let held: TmuxQueuedMessage | null = null;
  let panes: TmuxSession[] = [];
  let startCalls = 0;
  let readyResult: ((value: boolean) => void) | null = null;
  const PANES = [pane("%1", "Brief"), pane("%2", "Atw"), pane("%3", "Shell", "zsh"), pane("%4", "Plain")];
  const AGENTS = new Map([["%1", "claude"], ["%2", "claude"], ["%9", "claude"]]);

  beforeEach(async () => {
    sent = [];
    recorded = [];
    override = undefined;
    held = null;
    panes = PANES;
    startCalls = 0;
    readyResult = null;
    const app = express();
    app.use(express.json());
    app.use(createTmuxFeedbackRouter({
      listPanes: async () => panes,
      readPaneAgents: async (panes) => new Map(panes.flatMap((entry) => AGENTS.has(entry.name) ? [[entry.name, AGENTS.get(entry.name)!] as const] : [])),
      send: async (target, text) => {
        sent.push({ target, text });
        return held;
      },
      paneOverride: () => override,
      onSubmitted: (target) => recorded.push(target),
      startPane: async () => {
        startCalls += 1;
        return { pane: "%9", ready: new Promise<boolean>((resolve) => { readyResult = resolve; }) };
      }
    }));
    app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
      const record = error as { statusCode?: number; message?: string };
      res.status(record.statusCode ?? 500).json({ error: record.message });
    });
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
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
      expect(recorded).toEqual(["%9"]);
      expect(startCalls).toBe(1);
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

    it("drops the feedback without throwing when the agent never gets ready", async () => {
      const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
      try {
        const result = await post({ message: "lost" });
        expect(result.status).toBe(200);
        readyResult!(false);
        await vi.waitFor(() => expect(error).toHaveBeenCalledWith(expect.stringContaining("lost")));
        expect(sent).toEqual([]);
        expect(recorded).toEqual([]);
      } finally {
        error.mockRestore();
      }
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
