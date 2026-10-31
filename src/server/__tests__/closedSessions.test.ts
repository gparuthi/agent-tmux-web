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
  buildCtxPromptsArgs,
  closedSessionTitle,
  createClosedSessionsRouter,
  CtxPromptsCache,
  HandoffCache,
  isAgentSessionId,
  MAX_CLOSED_SESSIONS,
  parseCtxCommand,
  parseCtxPrompts,
  probeCtxHandoff,
  readCtxCommand,
  readCtxPrompts,
  RecentlyClosedSessions,
  REOPENED_GRACE_MS,
  resolveCtxBin,
  selectRecentlyClosed,
  type CtxPromptSession
} from "../closedSessions.js";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const T0 = Date.parse("2026-10-31T12:00:00Z");

const prompted = (n: number, extra: Partial<CtxPromptSession> = {}): CtxPromptSession => ({
  sessionId: id(n),
  host: "host-a",
  harness: "claude",
  project: "/Users/me/work/app",
  name: `task ${n}`,
  prompt: `prompt ${n}`,
  // Lower n is newer, as ctx lists them.
  promptedAtMs: T0 - n * 60_000,
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

describe("ctx prompts", () => {
  it("asks ctx for this host's sessions only, letting ctx resolve the host name", () => {
    expect(buildCtxPromptsArgs()).toEqual(["prompts", "--json", "--host", "local", "--since", "7d", "-k", "60"]);
  });

  it("parses sessions and drops malformed ones", () => {
    const output = JSON.stringify({
      count: 4,
      sessions: [
        { prompted_at: "2026-10-31T14:36:32.47Z", host: "host-a", harness: "claude", project: "/Users/me/work/app", session_id: id(1), name: "ATW", prompt: "hi", path: "/x.jsonl" },
        { prompted_at: "2026-10-31T14:00:00Z", host: "host-a", harness: "codex", project: "/w", session_id: id(2), prompt: "codex" },
        { prompted_at: "not a time", host: "host-a", harness: "claude", project: "/w", session_id: id(3) },
        { prompted_at: "2026-10-31T14:00:00Z", harness: "claude", project: "/w", session_id: id(4) },
        null
      ]
    });
    expect(parseCtxPrompts(output)).toEqual([
      { sessionId: id(1), host: "host-a", harness: "claude", project: "/Users/me/work/app", name: "ATW", prompt: "hi", promptedAtMs: Date.parse("2026-10-31T14:36:32.47Z") },
      { sessionId: id(2), host: "host-a", harness: "codex", project: "/w", name: "", prompt: "codex", promptedAtMs: Date.parse("2026-10-31T14:00:00Z") }
    ]);
    expect(() => parseCtxPrompts("error: no index")).toThrow(/no JSON/);
    expect(() => parseCtxPrompts("{}")).toThrow(/no sessions/);
  });

  it("runs ctx with argv only, and lists nothing without ctx", async () => {
    const dir = await makeTempDir();
    const bin = path.join(dir, "ctx");
    const argvFile = path.join(dir, "argv");
    const session = { prompted_at: "2026-10-31T14:00:00Z", host: "host-a", harness: "claude", project: "/w", session_id: id(1), name: "n", prompt: "p" };
    await writeFile(bin, [
      "#!/bin/sh",
      `printf '%s\\n' "$@" > '${argvFile}'`,
      `echo '${JSON.stringify({ sessions: [session] })}'`
    ].join("\n"));
    await chmod(bin, 0o755);

    expect((await readCtxPrompts(bin)).map((entry) => entry.sessionId)).toEqual([id(1)]);
    expect((await readFile(argvFile, "utf8")).trimEnd().split("\n")).toEqual(buildCtxPromptsArgs());
    expect(await readCtxPrompts(null)).toEqual([]);

    await writeFile(bin, "#!/bin/sh\necho 'error: index locked' >&2\nexit 1\n");
    await expect(readCtxPrompts(bin)).rejects.toMatchObject({ statusCode: 502, message: "error: index locked" });
  });
});

describe("recently closed selection", () => {
  it("keeps Claude sessions not live in a pane, newest prompt first, one per id", () => {
    const sessions = [
      prompted(3),
      prompted(1),
      prompted(2, { harness: "codex" }),
      prompted(4),
      prompted(5, { sessionId: "not-a-uuid" }),
      // An older copy of session 3.
      prompted(3, { promptedAtMs: T0 - 99 * 60_000, name: "old" })
    ];
    const closed = selectRecentlyClosed(sessions, new Set([id(4)]));
    expect(closed.map((entry) => [entry.sessionId, entry.title])).toEqual([[id(1), "task 1"], [id(3), "task 3"]]);
    expect(closed[0]).toEqual({ sessionId: id(1), agent: "claude", title: "task 1", cwd: "/Users/me/work/app", lastPrompt: "prompt 1", lastPromptAtMs: T0 - 60_000 });
  });

  it("caps the list", () => {
    const sessions = Array.from({ length: MAX_CLOSED_SESSIONS + 5 }, (_, index) => prompted(index + 1));
    const closed = selectRecentlyClosed(sessions, new Set());
    expect(closed).toHaveLength(MAX_CLOSED_SESSIONS);
    expect(closed.at(-1)?.sessionId).toBe(id(MAX_CLOSED_SESSIONS));
  });

  it("titles unnamed sessions by a short form of the prompt and flattens the prompt to one line", () => {
    expect(closedSessionTitle("  ATW  ", "x", id(1))).toBe("ATW");
    expect(closedSessionTitle("", "fix the\n  login   bug", id(1))).toBe("fix the login bug");
    const long = closedSessionTitle("", "word ".repeat(40), id(1));
    expect(long.length).toBeLessThanOrEqual(60);
    expect(long.endsWith("…")).toBe(true);
    expect(closedSessionTitle("", "  ", id(1))).toBe("00000000");
    const [entry] = selectRecentlyClosed([prompted(1, { name: "", prompt: "line one\nline two" })], new Set());
    expect(entry).toMatchObject({ title: "line one line two", lastPrompt: "line one line two" });
  });
});

describe("CtxPromptsCache", () => {
  it("waits for the first read, then serves the cached list and refreshes it once when stale", async () => {
    let nowMs = 0;
    let n = 0;
    const read = vi.fn(async () => [prompted((n += 1))]);
    const cache = new CtxPromptsCache(read, () => nowMs, 1000);
    expect((await cache.get()).map((entry) => entry.sessionId)).toEqual([id(1)]);
    nowMs = 999;
    await cache.get();
    expect(read).toHaveBeenCalledTimes(1);

    nowMs = 1000;
    // Stale: answered from the cache while one background refresh runs.
    const [first, second] = await Promise.all([cache.get(), cache.get()]);
    expect(first.map((entry) => entry.sessionId)).toEqual([id(1)]);
    expect(second).toBe(first);
    expect(read).toHaveBeenCalledTimes(2);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect((await cache.get()).map((entry) => entry.sessionId)).toEqual([id(2)]);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("shares one read between concurrent first calls", async () => {
    const read = vi.fn(async () => [prompted(1)]);
    const cache = new CtxPromptsCache(read);
    await Promise.all([cache.get(), cache.get(), cache.refresh()]);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("keeps the last list when a refresh fails and waits an interval before retrying", async () => {
    let nowMs = 0;
    const read = vi.fn(async () => [prompted(1)]);
    const cache = new CtxPromptsCache(read, () => nowMs, 1000);
    await cache.get();
    read.mockRejectedValueOnce(new Error("ctx failed"));
    nowMs = 1000;
    expect((await cache.refresh()).map((entry) => entry.sessionId)).toEqual([id(1)]);
    nowMs = 1500;
    await cache.get();
    expect(read).toHaveBeenCalledTimes(2);

    const failing = new CtxPromptsCache(async () => {
      throw new Error("ctx failed");
    });
    await expect(failing.get()).rejects.toThrow("ctx failed");
  });
});

describe("RecentlyClosedSessions", () => {
  it("lists nothing until the Claude session scan has run, and hides a reopened session for a grace period", async () => {
    let nowMs = T0;
    let live: Set<string> | null = null;
    const closed = new RecentlyClosedSessions({
      prompts: async () => [prompted(1), prompted(2), prompted(3)],
      liveSessionIds: async () => live,
      now: () => nowMs
    });
    expect(await closed.list()).toEqual([]);

    live = new Set([id(2)]);
    expect((await closed.list()).map((entry) => entry.sessionId)).toEqual([id(1), id(3)]);

    closed.markReopened(id(1));
    expect((await closed.list()).map((entry) => entry.sessionId)).toEqual([id(3)]);
    nowMs += REOPENED_GRACE_MS;
    expect((await closed.list()).map((entry) => entry.sessionId)).toEqual([id(1), id(3)]);
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
  let prompts: CtxPromptSession[];
  const readCommand = vi.fn(async (sessionId: string, mode: string) => `cd '/Users/me/work/app' && ${mode === "handoff" ? "claude 'Continue'" : `claude -r ${sessionId}`}`);
  const openWindow = vi.fn(async () => ({ pane: "%42", directory: "/Users/me/work/app", windowName: "task 1" }));
  const onOpened = vi.fn();

  beforeEach(async () => {
    readCommand.mockClear();
    openWindow.mockClear();
    onOpened.mockClear();
    prompts = [prompted(1), prompted(2, { project: "/Users/me/work/api", name: "" }), prompted(3)];
    const app = express();
    app.use(express.json());
    app.use(createClosedSessionsRouter({
      closed: new RecentlyClosedSessions({ prompts: async () => prompts, liveSessionIds: async () => new Set([id(3)]) }),
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
    // Session 3 is live in a pane.
    expect(data.map((entry) => [entry.sessionId, entry.title, entry.handoff])).toEqual([[id(1), "task 1", true], [id(2), "prompt 2", false]]);
    expect(data[0]).toEqual({
      sessionId: id(1),
      agent: "claude",
      title: "task 1",
      cwd: "/Users/me/work/app",
      cwdLabel: "/…/work/app",
      lastPrompt: "prompt 1",
      lastPromptAtMs: T0 - 60_000,
      handoff: true
    });
  });

  it("rejects bad ids, bad modes and sessions not in the recently closed list, before running ctx", async () => {
    for (const sessionId of ["", "--fresh", `${id(1)} --fresh`, "x".repeat(36), 7]) {
      expect((await request("POST", "/api/tmux/closed-sessions/reopen", { sessionId, mode: "resume" })).status, String(sessionId)).toBe(400);
    }
    for (const mode of ["", "fresh", "RESUME", null]) {
      expect((await request("POST", "/api/tmux/closed-sessions/reopen", { sessionId: id(1), mode })).status, String(mode)).toBe(400);
    }
    expect((await request("POST", "/api/tmux/closed-sessions/reopen", { sessionId: id(9), mode: "resume" })).status).toBe(404);
    // Live in a pane, so not closed.
    expect((await request("POST", "/api/tmux/closed-sessions/reopen", { sessionId: id(3), mode: "resume" })).status).toBe(404);
    expect(readCommand).not.toHaveBeenCalled();
    expect(openWindow).not.toHaveBeenCalled();
  });

  it("opens ctx's line in a new window, hides the entry and returns the new pane", async () => {
    const result = await request("POST", "/api/tmux/closed-sessions/reopen", { sessionId: id(1), mode: "handoff" });
    expect(result.status).toBe(200);
    const data = result.json.data as ReopenClosedSessionResultDto;
    expect(readCommand).toHaveBeenCalledWith(id(1), "handoff");
    expect(openWindow).toHaveBeenCalledWith("cd '/Users/me/work/app' && claude 'Continue'", expect.objectContaining({ sessionId: id(1), title: "task 1" }));
    expect(onOpened).toHaveBeenCalledWith("%42");
    expect(data.pane).toBe("%42");
    expect(data.sessions.map((session) => session.name)).toEqual(["%42"]);
    expect(data.closed.map((entry) => entry.sessionId)).toEqual([id(2)]);
    expect(((await request("GET", "/api/tmux/closed-sessions")).json.data as ClosedSessionDto[]).map((entry) => entry.sessionId)).toEqual([id(2)]);
  });

  it("keeps the entry when ctx fails", async () => {
    readCommand.mockRejectedValueOnce(Object.assign(new Error("no ctx handoff for codex:00000000"), { statusCode: 502 }));
    const result = await request("POST", "/api/tmux/closed-sessions/reopen", { sessionId: id(2), mode: "handoff" });
    expect(result).toEqual({ status: 502, json: { error: "no ctx handoff for codex:00000000" } });
    expect(openWindow).not.toHaveBeenCalled();
    expect(((await request("GET", "/api/tmux/closed-sessions")).json.data as ClosedSessionDto[]).map((entry) => entry.sessionId)).toEqual([id(1), id(2)]);
  });
});
