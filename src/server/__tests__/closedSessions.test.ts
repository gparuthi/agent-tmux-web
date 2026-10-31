import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import express, { type NextFunction, type Request, type Response } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ClosedSessionDto, ReopenClosedSessionResultDto } from "../../shared/api.js";
import {
  buildCtxCmdArgs,
  ClosedSessionTracker,
  collectLiveAgentPanes,
  createClosedSessionsRouter,
  HandoffCache,
  isAgentSessionId,
  MAX_CLOSED_SESSIONS,
  parseClosedSessionsFile,
  parseCtxCommand,
  probeCtxHandoff,
  readCtxCommand,
  resolveCtxBin,
  type LiveAgentPane
} from "../closedSessions.js";
import type { TmuxSession } from "../tmux.js";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const live = (name: string, n: number, extra: Partial<LiveAgentPane> = {}): LiveAgentPane => ({
  name,
  agent: "claude",
  sessionId: id(n),
  cwd: "/Users/me/work/app",
  title: `task ${n}`,
  ...extra
});

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "atw-closed-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("ClosedSessionTracker", () => {
  it("records an agent pane once it disappears, and ignores panes it never saw with a session", () => {
    let nowMs = 1000;
    const onClosed = vi.fn();
    const tracker = new ClosedSessionTracker({ filePath: null, now: () => nowMs, onClosed });
    tracker.remember([live("%1", 1, { lastPromptAtMs: 900 }), live("%2", 2)]);
    tracker.sweep([{ name: "%1" }, { name: "%2" }, { name: "%3" }]);
    expect(tracker.list()).toEqual([]);

    nowMs = 2000;
    tracker.sweep([{ name: "%2" }]);
    expect(tracker.list()).toEqual([{ sessionId: id(1), agent: "claude", cwd: "/Users/me/work/app", title: "task 1", closedAtMs: 2000, lastPromptAtMs: 900 }]);
    expect(onClosed).toHaveBeenCalledTimes(1);
    // A pane is recorded once, not on every later sweep.
    tracker.sweep([{ name: "%2" }]);
    expect(tracker.list()).toHaveLength(1);
  });

  it("treats a reused pane id with a newer creation time as the old pane closing", () => {
    const tracker = new ClosedSessionTracker({ filePath: null, now: () => 5000 });
    tracker.remember([live("%4", 4, { createdAtMs: 100 })]);
    tracker.sweep([{ name: "%4", createdAtMs: 100 }]);
    expect(tracker.list()).toEqual([]);
    tracker.sweep([{ name: "%4", createdAtMs: 4000 }]);
    expect(tracker.list().map((entry) => entry.sessionId)).toEqual([id(4)]);
  });

  it("keeps one entry per session id, newest first, and drops it when the session is live again", () => {
    let nowMs = 1000;
    const tracker = new ClosedSessionTracker({ filePath: null, now: () => nowMs });
    tracker.remember([live("%1", 1), live("%2", 2)]);
    tracker.sweep([]);
    nowMs = 2000;
    // The same session resumed in another pane and closed again.
    tracker.remember([live("%5", 1, { title: "renamed" })]);
    expect(tracker.list().map((entry) => entry.sessionId)).toEqual([id(2)]);
    tracker.sweep([]);
    expect(tracker.list().map((entry) => [entry.sessionId, entry.title, entry.closedAtMs])).toEqual([[id(1), "renamed", 2000], [id(2), "task 2", 1000]]);
  });

  it("caps the list at the newest entries", () => {
    let nowMs = 0;
    const tracker = new ClosedSessionTracker({ filePath: null, now: () => nowMs });
    for (let n = 1; n <= MAX_CLOSED_SESSIONS + 5; n += 1) {
      nowMs = n;
      tracker.remember([live(`%${n}`, n)]);
      tracker.sweep([]);
    }
    expect(tracker.list()).toHaveLength(MAX_CLOSED_SESSIONS);
    expect(tracker.list()[0].sessionId).toBe(id(MAX_CLOSED_SESSIONS + 5));
    expect(tracker.list().at(-1)?.sessionId).toBe(id(6));
  });

  it("persists the list and loads it back, without the live panes", async () => {
    const filePath = path.join(await makeTempDir(), "state", "closed-sessions.json");
    const tracker = new ClosedSessionTracker({ filePath, now: () => 3000, debounceMs: 60_000 });
    tracker.remember([live("%1", 1), live("%2", 2)]);
    tracker.sweep([{ name: "%2" }]);
    await tracker.flush();
    expect(JSON.parse(await readFile(filePath, "utf8"))).toEqual({ version: 1, entries: tracker.list() });

    const restarted = new ClosedSessionTracker({ filePath, now: () => 4000 });
    await restarted.load();
    expect(restarted.list()).toEqual(tracker.list());
    // Panes from before the restart are unknown, so their closures go unrecorded.
    restarted.sweep([]);
    expect(restarted.list()).toHaveLength(1);
    restarted.remove(id(1));
    expect(restarted.list()).toEqual([]);
  });

  it("drops malformed entries and unknown file versions", () => {
    const good = { sessionId: id(1), agent: "codex", cwd: "/w", title: "t", closedAtMs: 5 };
    expect(parseClosedSessionsFile(JSON.stringify({ version: 1, entries: [good, { ...good, sessionId: "../../etc" }, { ...good, closedAtMs: "x" }, null] }))).toEqual([good]);
    expect(parseClosedSessionsFile(JSON.stringify({ version: 2, entries: [good] }))).toEqual([]);
    expect(parseClosedSessionsFile("not json")).toEqual([]);
  });
});

describe("live agent panes", () => {
  const pane = (name: string, extra: Partial<TmuxSession> = {}): TmuxSession => ({
    name,
    paneId: name.match(/%\d+$/)?.[0],
    windows: 1,
    created: "",
    attached: false,
    clientCount: 0,
    ...extra
  });

  it("takes Claude ids from its session files and Codex ids from its resume argv, local panes only", () => {
    const panes = [
      pane("%1", { displayName: "fix auth", createdAtMs: 10 }),
      pane("%2", { displayName: "codex work", currentPath: "/Users/me/work/api" }),
      pane("%3", { displayName: "plain codex" }),
      pane("dk--box--%4", { displayName: "remote" }),
      pane("%5", { displayName: "shell" })
    ];
    const result = collectLiveAgentPanes(panes, {
      agents: new Map([["%1", "claude"], ["%2", "codex"], ["%3", "codex"], ["dk--box--%4", "claude"]]),
      claudeSessions: new Map([["%1", { sessionId: id(1), cwd: "/Users/me/work/app" }], ["dk--box--%4", { sessionId: id(4), cwd: "/x" }], ["%5", { sessionId: "not-a-uuid", cwd: "/x" }]]),
      codexSessions: new Map([["%2", id(2)]]),
      lastPromptAtMs: (entry) => (entry.name === "%1" ? 99 : undefined)
    });
    expect(result).toEqual([
      { name: "%1", createdAtMs: 10, agent: "claude", sessionId: id(1), cwd: "/Users/me/work/app", title: "fix auth", lastPromptAtMs: 99 },
      { name: "%2", agent: "codex", sessionId: id(2), cwd: "/Users/me/work/api", title: "codex work" }
    ]);
  });
});

describe("HandoffCache", () => {
  it("waits for first probes, serves cached answers, and refreshes stale ones in the background", async () => {
    let nowMs = 0;
    const probe = vi.fn(async (sessionId: string) => {
      if (sessionId === id(3)) {
        throw new Error("ctx failed");
      }
      return sessionId === id(1);
    });
    const cache = new HandoffCache(probe, () => nowMs, 1000);
    expect(await cache.lookup([id(1), id(2), id(3)])).toEqual(new Map([[id(1), true], [id(2), false], [id(3), false]]));
    expect(probe).toHaveBeenCalledTimes(3);

    await cache.lookup([id(1), id(2)]);
    expect(probe).toHaveBeenCalledTimes(3);

    nowMs = 1000;
    expect(await cache.lookup([id(1)])).toEqual(new Map([[id(1), true]]));
    expect(probe).toHaveBeenCalledTimes(4);
  });

  it("shares one probe between concurrent lookups", async () => {
    const probe = vi.fn(async () => true);
    const cache = new HandoffCache(probe);
    await Promise.all([cache.lookup([id(1)]), cache.lookup([id(1)]), cache.refresh(id(1))]);
    expect(probe).toHaveBeenCalledTimes(1);
  });
});

describe("ctx commands", () => {
  it("validates agent session ids", () => {
    expect(isAgentSessionId("beead8d3-8217-458e-a30a-3c4a4e190ae7")).toBe(true);
    expect(isAgentSessionId("019A2B3C-4D5E-7F60-8A9B-0C1D2E3F4A5B")).toBe(true);
    for (const value of ["", "beead8d3", "--fresh", "beead8d3-8217-458e-a30a-3c4a4e190ae7; rm -rf ~", " beead8d3-8217-458e-a30a-3c4a4e190ae7", 42, null]) {
      expect(isAgentSessionId(value), String(value)).toBe(false);
    }
  });

  it("builds argv and reads ctx's single cd line", () => {
    expect(buildCtxCmdArgs(id(1), "resume")).toEqual(["cmd", id(1)]);
    expect(buildCtxCmdArgs(id(1), "handoff")).toEqual(["cmd", id(1), "--fresh"]);
    expect(parseCtxCommand("cd '/Users/me/work/app' && claude -r x\n")).toBe("cd '/Users/me/work/app' && claude -r x");
    expect(() => parseCtxCommand("")).toThrow(/no command/);
    expect(() => parseCtxCommand("usage: ctx cmd\ncd x")).toThrow(/no command/);
  });

  it("resolves the ctx wrapper from HOME, overridable and disabled by env", () => {
    expect(resolveCtxBin({ HOME: "/Users/me" })).toBe("/Users/me/.gp/tools/context-engine/ctx");
    expect(resolveCtxBin({ HOME: "/Users/me", ATW_CTX_BIN: "/opt/ctx" })).toBe("/opt/ctx");
    expect(resolveCtxBin({ HOME: "/Users/me", ATW_CTX_BIN: "" })).toBeNull();
  });

  it("runs ctx with argv only and reports its error text", async () => {
    const dir = await makeTempDir();
    const bin = path.join(dir, "ctx");
    const argvFile = path.join(dir, "argv");
    await writeFile(bin, [
      "#!/bin/sh",
      `printf '%s\\n' "$@" > '${argvFile}'`,
      `if [ "$3" = --fresh ]; then echo 'no ctx handoff for claude:00000000' >&2; exit 1; fi`,
      "echo \"cd '/Users/me/work/app' && claude -r $2\""
    ].join("\n"));
    await chmod(bin, 0o755);

    expect(await readCtxCommand(bin, id(7), "resume")).toBe(`cd '/Users/me/work/app' && claude -r ${id(7)}`);
    expect((await readFile(argvFile, "utf8")).trimEnd().split("\n")).toEqual(["cmd", id(7)]);
    await expect(readCtxCommand(bin, id(7), "handoff")).rejects.toMatchObject({ statusCode: 502, message: "no ctx handoff for claude:00000000" });
    await expect(readCtxCommand(null, id(7), "resume")).rejects.toMatchObject({ statusCode: 404 });
    expect(await probeCtxHandoff(async () => bin)(id(7)).catch(() => false)).toBe(false);
  });
});

describe("closed sessions endpoints", () => {
  let server: http.Server;
  let baseUrl = "";
  let tracker: ClosedSessionTracker;
  const readCommand = vi.fn(async (sessionId: string, mode: string) => `cd '/Users/me/work/app' && ${mode === "handoff" ? "claude 'Continue'" : `claude -r ${sessionId}`}`);
  const openWindow = vi.fn(async () => ({ pane: "%42", directory: "/Users/me/work/app", windowName: "task 1" }));
  const onOpened = vi.fn();

  beforeEach(async () => {
    readCommand.mockClear();
    openWindow.mockClear();
    onOpened.mockClear();
    tracker = new ClosedSessionTracker({ filePath: null, now: () => 1000 });
    tracker.remember([live("%1", 1), live("%2", 2, { agent: "codex", cwd: "/Users/me/work/api" })]);
    tracker.sweep([]);
    const app = express();
    app.use(express.json());
    app.use(createClosedSessionsRouter({
      tracker,
      handoffs: new HandoffCache(async (sessionId) => sessionId === id(1)),
      readCommand,
      openWindow,
      listSessions: async () => [{ name: "%42", windows: 1, created: "", attached: false }],
      onOpened
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

  async function request(method: "GET" | "POST", url: string, body?: unknown) {
    const response = await fetch(`${baseUrl}${url}`, {
      method,
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    return { status: response.status, json: await response.json() as Record<string, unknown> };
  }

  it("lists closed sessions with their handoff flag", async () => {
    const result = await request("GET", "/api/tmux/closed-sessions");
    expect(result.status).toBe(200);
    const data = result.json.data as ClosedSessionDto[];
    // Both closed in one sweep; the later-recorded one lists first.
    expect(data.map((entry) => [entry.sessionId, entry.agent, entry.handoff])).toEqual([[id(2), "codex", false], [id(1), "claude", true]]);
    expect(data[1]).toMatchObject({ title: "task 1", cwd: "/Users/me/work/app", closedAtMs: 1000 });
  });

  it("rejects bad ids, bad modes and sessions it did not see close, before running ctx", async () => {
    for (const sessionId of ["", "--fresh", `${id(1)} --fresh`, "x".repeat(36), 7]) {
      expect((await request("POST", "/api/tmux/closed-sessions/reopen", { sessionId, mode: "resume" })).status, String(sessionId)).toBe(400);
    }
    for (const mode of ["", "fresh", "RESUME", null]) {
      expect((await request("POST", "/api/tmux/closed-sessions/reopen", { sessionId: id(1), mode })).status, String(mode)).toBe(400);
    }
    expect((await request("POST", "/api/tmux/closed-sessions/reopen", { sessionId: id(9), mode: "resume" })).status).toBe(404);
    expect(readCommand).not.toHaveBeenCalled();
    expect(openWindow).not.toHaveBeenCalled();
  });

  it("opens ctx's line in a new window, removes the entry and returns the new pane", async () => {
    const result = await request("POST", "/api/tmux/closed-sessions/reopen", { sessionId: id(1), mode: "handoff" });
    expect(result.status).toBe(200);
    const data = result.json.data as ReopenClosedSessionResultDto;
    expect(readCommand).toHaveBeenCalledWith(id(1), "handoff");
    expect(openWindow).toHaveBeenCalledWith("cd '/Users/me/work/app' && claude 'Continue'", expect.objectContaining({ sessionId: id(1), title: "task 1" }));
    expect(onOpened).toHaveBeenCalledWith("%42");
    expect(data.pane).toBe("%42");
    expect(data.sessions.map((session) => session.name)).toEqual(["%42"]);
    expect(data.closed.map((entry) => entry.sessionId)).toEqual([id(2)]);
    expect(tracker.find(id(1))).toBeUndefined();
  });

  it("keeps the entry when ctx fails", async () => {
    readCommand.mockRejectedValueOnce(Object.assign(new Error("no ctx handoff for codex:00000000"), { statusCode: 502 }));
    const result = await request("POST", "/api/tmux/closed-sessions/reopen", { sessionId: id(2), mode: "handoff" });
    expect(result).toEqual({ status: 502, json: { error: "no ctx handoff for codex:00000000" } });
    expect(openWindow).not.toHaveBeenCalled();
    expect(tracker.find(id(2))).toBeDefined();
  });
});
