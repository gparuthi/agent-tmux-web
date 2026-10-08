import http from "node:http";
import type { AddressInfo } from "node:net";

import express, { type NextFunction, type Request, type Response } from "express";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { TmuxSession } from "../tmux.js";
import { createTmuxRenameRouter } from "../tmuxRename.js";

const pane = (name: string, currentCommand: string, paneId: string | undefined = name.match(/%\d+$/)?.[0]): TmuxSession => ({
  name,
  session: "main",
  ...(paneId ? { paneId } : {}),
  windows: 1,
  created: "",
  attached: false,
  clientCount: 0,
  currentCommand
});

const PANES = [
  pane("%1", "2.1.294"),
  pane("%2", "node"),
  pane("%3", "node"),
  pane("%4", "zsh"),
  pane("%5", "opencode"),
  pane("dk--box--%6", "2.1.294"),
  pane("legacy", "2.1.294", undefined)
];
// What process-tree detection reports: %2 is codex under node, %3 is pi, %4 is a plain shell.
const AGENTS = new Map([["%1", "claude"], ["%2", "codex"], ["%3", "pi"], ["%5", "opencode"], ["dk--box--%6", "claude"]]);

describe("tmux rename endpoint", () => {
  let server: http.Server;
  let baseUrl = "";
  let sent: Array<{ target: string; text: string }> = [];
  let recorded: string[] = [];
  let detectedFor: string[][] = [];

  beforeEach(async () => {
    sent = [];
    recorded = [];
    detectedFor = [];
    const app = express();
    app.use(express.json());
    app.use(createTmuxRenameRouter({
      listPanes: async () => PANES,
      readPaneAgents: async (panes) => {
        detectedFor.push(panes.map((entry) => entry.name));
        return new Map(panes.flatMap((entry) => AGENTS.has(entry.name) ? [[entry.name, AGENTS.get(entry.name)!] as const] : []));
      },
      submitText: async (target, text) => {
        sent.push({ target, text });
      },
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

  async function rename(body: unknown) {
    const response = await fetch(`${baseUrl}/api/tmux/rename`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    return { status: response.status, json: await response.json() as Record<string, unknown> };
  }

  it("types each agent's rename command into the pane", async () => {
    const claude = await rename({ target: "%1", name: "Fix the build" });
    expect(claude.status).toBe(200);
    expect(claude.json.data).toEqual({ target: "%1", agent: "claude", name: "Fix the build", text: "/rename Fix the build" });
    expect((await rename({ target: "%2", name: "codex thread" })).status).toBe(200);
    expect((await rename({ target: "%3", name: "pi session" })).status).toBe(200);
    expect((await rename({ target: "dk--box--%6", name: "remote" })).status).toBe(200);
    expect(sent).toEqual([
      { target: "%1", text: "/rename Fix the build" },
      { target: "%2", text: "/rename codex thread" },
      { target: "%3", text: "/name pi session" },
      { target: "dk--box--%6", text: "/rename remote" }
    ]);
    expect(recorded).toEqual(["%1", "%2", "%3", "dk--box--%6"]);
    expect(detectedFor[0]).toEqual(["%1"]);
  });

  it("strips newlines and control characters before typing", async () => {
    const result = await rename({ target: "%1", name: "  one\ntwo\r\u001b[2Jthree\u0003 " });
    expect(result.status).toBe(200);
    expect(sent).toEqual([{ target: "%1", text: "/rename one two [2Jthree" }]);
  });

  it("rejects empty names without typing anything", async () => {
    for (const name of ["", "   ", "\n\n", "\u0003", 7, null, undefined]) {
      const result = await rename({ target: "%1", name });
      expect(result.status, JSON.stringify(name)).toBe(400);
      expect(String(result.json.error)).toMatch(/Enter a name/);
    }
    expect(sent).toEqual([]);
  });

  it("refuses panes without a rename-capable agent", async () => {
    for (const target of ["%4", "%5"]) {
      const result = await rename({ target, name: "x" });
      expect(result.status, target).toBe(400);
      expect(String(result.json.error)).toMatch(/Rename needs Claude, Codex or Pi/);
    }
    expect(sent).toEqual([]);
  });

  it("refuses unknown and session-name targets", async () => {
    for (const target of ["%99", "main", "legacy", "", 12, null]) {
      expect((await rename({ target, name: "x" })).status, String(target)).toBe(400);
    }
    expect(sent).toEqual([]);
  });

  it("reports a failed send", async () => {
    const app = express();
    app.use(express.json());
    app.use(createTmuxRenameRouter({
      listPanes: async () => PANES,
      readPaneAgents: async () => AGENTS,
      submitText: async () => {
        throw new Error("can't find pane: %1");
      },
      onSubmitted: (target) => recorded.push(target)
    }));
    app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
      res.status(500).json({ error: (error as Error).message });
    });
    const failing = http.createServer(app);
    await new Promise<void>((resolve) => failing.listen(0, "127.0.0.1", resolve));
    const response = await fetch(`http://127.0.0.1:${(failing.address() as AddressInfo).port}/api/tmux/rename`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ target: "%1", name: "x" })
    });
    await new Promise((resolve) => failing.close(resolve));
    expect(response.status).toBe(500);
    expect(recorded).toEqual([]);
  });
});
