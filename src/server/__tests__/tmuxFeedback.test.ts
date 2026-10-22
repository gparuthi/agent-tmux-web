import http from "node:http";
import type { AddressInfo } from "node:net";

import express, { type NextFunction, type Request, type Response } from "express";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

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
  const PANES = [pane("%1", "Brief"), pane("%2", "Atw"), pane("%3", "Shell", "zsh"), pane("%4", "Plain")];
  const AGENTS = new Map([["%1", "claude"], ["%2", "claude"]]);

  beforeEach(async () => {
    sent = [];
    recorded = [];
    override = undefined;
    held = null;
    const app = express();
    app.use(express.json());
    app.use(createTmuxFeedbackRouter({
      listPanes: async () => PANES,
      readPaneAgents: async (panes) => new Map(panes.flatMap((entry) => AGENTS.has(entry.name) ? [[entry.name, AGENTS.get(entry.name)!] as const] : [])),
      send: async (target, text) => {
        sent.push({ target, text });
        return held;
      },
      paneOverride: () => override,
      onSubmitted: (target) => recorded.push(target)
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
});
