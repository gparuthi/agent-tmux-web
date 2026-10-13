import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import express, { type NextFunction, type Request, type Response } from "express";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { TmuxSessionStatusKind } from "../../shared/api.js";
import type { AgentRow, AgentRowsSnapshot } from "../agentRows.js";
import {
  createTmuxSendRouter,
  paneReadyForInput,
  parseTmuxSendQueueFile,
  SEND_SETTLE_MS,
  TmuxSendQueue,
  type TmuxQueuedMessage,
  type TmuxSendRequest
} from "../tmuxSendQueue.js";

const START_MS = 1_791_144_148_000;

function agentRow(paneId: string, kind: string, status: TmuxSessionStatusKind, idleSinceSec?: number): AgentRow {
  return { paneId, kind, status, ...(idleSinceSec !== undefined ? { idleSinceSec } : {}) };
}

// A fake agent-status plus a recording tmux: tests set pane states and the clock, then tick.
class World {
  nowMs = START_MS;
  snapshotAtMs: number | null = START_MS;
  panes = new Map<string, AgentRow>();
  typed: Array<{ target: string; text: string; enter: boolean; submitKey: string }> = [];
  delivered: string[] = [];
  failTyping = false;
  private ids = 0;

  set(paneId: string, kind: string, status: TmuxSessionStatusKind, idleSinceSec?: number): void {
    this.panes.set(paneId, agentRow(paneId, kind, status, idleSinceSec));
  }

  // agent-status rescans: a new snapshot at the current time.
  advance(ms: number): void {
    this.nowMs += ms;
    if (this.snapshotAtMs !== null) {
      this.snapshotAtMs = this.nowMs;
    }
  }

  queue(filePath: string | null = null): TmuxSendQueue {
    return new TmuxSendQueue({
      filePath,
      readRows: async (): Promise<AgentRowsSnapshot | null> => this.snapshotAtMs === null
        ? null
        : { epochSec: Math.floor(this.snapshotAtMs / 1000), rows: new Map(this.panes) },
      typeText: async (target, text, enter, submitKey) => {
        if (this.failTyping) {
          throw new Error("can't find pane");
        }
        this.typed.push({ target, text, enter, submitKey });
      },
      onDelivered: (message) => this.delivered.push(message.text),
      now: () => this.nowMs,
      newId: () => `q${++this.ids}`
    });
  }

  texts(): string[] {
    return this.typed.map((entry) => entry.text);
  }
}

function request(target: string, text: string): TmuxSendRequest {
  return { target, text, enter: true, submitKey: "enter" };
}

describe("tmux send queue", () => {
  let world: World;

  beforeEach(() => {
    world = new World();
  });

  it("types straight away for agents that queue their own type-ahead, and when agent-status is down", async () => {
    world.set("%1", "claude", "working");
    world.set("%2", "codex", "working");
    world.set("%3", "pi", "working");
    world.set("%4", "opencode", "working");
    const queue = world.queue();
    for (const target of ["%1", "%2", "%3", "%4", "%9"]) {
      expect(await queue.send(request(target, `to ${target}`))).toBeNull();
    }
    world.snapshotAtMs = null;
    world.set("%5", "hax", "working");
    expect(await queue.send(request("%5", "no snapshot"))).toBeNull();
    expect(world.texts()).toEqual(["to %1", "to %2", "to %3", "to %4", "to %9", "no snapshot"]);
    expect(queue.list()).toEqual([]);
  });

  it("holds text for a working hax pane instead of typing it", async () => {
    world.set("%5", "hax", "working");
    const queue = world.queue();
    const held = await queue.send({ ...request("%5", "next task"), label: "Tmux task" });
    expect(held).toEqual({
      id: "q1",
      target: "%5",
      agent: "hax",
      text: "next task",
      enter: true,
      submitKey: "enter",
      label: "Tmux task",
      queuedAtMs: START_MS
    } satisfies TmuxQueuedMessage);
    expect(world.typed).toEqual([]);
    expect(queue.list("%5").map((message) => message.text)).toEqual(["next task"]);
    expect(queue.list("%6")).toEqual([]);
  });

  it("types into an idle hax pane, then holds the next message until that turn is seen to end", async () => {
    world.set("%5", "hax", "idle", Math.floor(START_MS / 1000) - 60);
    const queue = world.queue();
    expect(await queue.send(request("%5", "first"))).toBeNull();
    // agent-status has not rescanned since, so the pane still reads idle: hold anyway.
    world.advance(500);
    expect(await queue.send(request("%5", "second"))).not.toBeNull();
    expect(world.texts()).toEqual(["first"]);

    world.advance(1000);
    world.set("%5", "hax", "working");
    await queue.tick();
    expect(world.texts()).toEqual(["first"]);

    world.advance(1000);
    world.set("%5", "hax", "done", Math.floor(world.nowMs / 1000));
    await queue.tick();
    expect(world.texts()).toEqual(["first", "second"]);
    expect(world.delivered).toEqual(["second"]);
    expect(queue.list()).toEqual([]);
  });

  it("delivers one message per return to ready, oldest first", async () => {
    world.set("%5", "hax", "working");
    const queue = world.queue();
    await queue.send(request("%5", "one"));
    await queue.send(request("%5", "two"));
    await queue.send(request("%5", "three"));

    world.advance(1000);
    await queue.tick();
    expect(world.texts()).toEqual([]);

    for (const [status, expected] of [
      ["done", ["one"]],
      ["done", ["one"]],
      ["working", ["one"]],
      ["blocked", ["one", "two"]],
      ["working", ["one", "two"]],
      ["idle", ["one", "two", "three"]]
    ] as const) {
      world.advance(1000);
      world.set("%5", "hax", status, status === "working" || status === "blocked" ? undefined : Math.floor(world.nowMs / 1000) - 5);
      await queue.tick();
      expect(world.texts()).toEqual(expected);
    }
    expect(queue.list()).toEqual([]);
  });

  it("keeps panes independent", async () => {
    world.set("%5", "hax", "working");
    world.set("%6", "hax", "working");
    const queue = world.queue();
    await queue.send(request("%5", "for five"));
    await queue.send(request("%6", "for six"));
    world.advance(1000);
    world.set("%6", "hax", "idle", Math.floor(world.nowMs / 1000));
    await queue.tick();
    expect(world.typed).toEqual([{ target: "%6", text: "for six", enter: true, submitKey: "enter" }]);
    expect(queue.list().map((message) => message.target)).toEqual(["%5"]);
  });

  it("queues behind waiting messages even when the pane is ready, keeping FIFO", async () => {
    world.set("%5", "hax", "working");
    const queue = world.queue();
    await queue.send(request("%5", "older"));
    world.advance(1000);
    world.set("%5", "hax", "idle", Math.floor(world.nowMs / 1000));
    expect(await queue.send(request("%5", "newer"))).not.toBeNull();
    expect(world.typed).toEqual([]);
    await queue.tick();
    expect(world.texts()).toEqual(["older"]);
  });

  it("counts a turn too quick for any snapshot once a later snapshot still reads ready", async () => {
    world.set("%5", "hax", "idle", Math.floor(START_MS / 1000) - 60);
    const queue = world.queue();
    await queue.send(request("%5", "quick"));
    await queue.send(request("%5", "after quick"));

    world.advance(SEND_SETTLE_MS - 1000);
    await queue.tick();
    expect(world.texts()).toEqual(["quick"]);

    world.advance(1000);
    await queue.tick();
    expect(world.texts()).toEqual(["quick", "after quick"]);
  });

  it("cancels a held message so the next one goes instead", async () => {
    world.set("%5", "hax", "working");
    const queue = world.queue();
    const first = await queue.send(request("%5", "drop me"));
    await queue.send(request("%5", "keep me"));
    expect(queue.cancel(first!.id)).toBe(true);
    expect(queue.cancel(first!.id)).toBe(false);
    world.advance(1000);
    world.set("%5", "hax", "done", Math.floor(world.nowMs / 1000));
    await queue.tick();
    expect(world.texts()).toEqual(["keep me"]);
  });

  it("holds while the pane's row is missing or unknown and keeps a message whose typing failed", async () => {
    world.set("%5", "hax", "working");
    const queue = world.queue();
    await queue.send(request("%5", "waiting"));

    world.panes.delete("%5");
    world.advance(1000);
    await queue.tick();
    world.set("%5", "hax", "unknown");
    world.advance(1000);
    await queue.tick();
    expect(world.typed).toEqual([]);

    world.set("%5", "hax", "idle", Math.floor(world.nowMs / 1000));
    world.failTyping = true;
    world.advance(1000);
    await queue.tick();
    expect(queue.list().map((message) => message.text)).toEqual(["waiting"]);

    world.failTyping = false;
    world.advance(1000);
    await queue.tick();
    expect(world.texts()).toEqual(["waiting"]);
  });

  it("forgets everything held for a closed pane", async () => {
    world.set("%5", "hax", "working");
    const queue = world.queue();
    await queue.send(request("%5", "orphan"));
    queue.clearTarget("%5");
    world.advance(1000);
    world.set("%5", "hax", "idle", Math.floor(world.nowMs / 1000));
    await queue.tick();
    expect(world.typed).toEqual([]);
    expect(queue.list()).toEqual([]);
  });

  describe("persistence", () => {
    let dir = "";
    let filePath = "";

    beforeEach(async () => {
      dir = await mkdtemp(path.join(tmpdir(), "atw-send-queue-"));
      filePath = path.join(dir, "atw", "send-queue.json");
    });

    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it("survives a restart and delivers what the old server held", async () => {
      world.set("%5", "hax", "working");
      const before = world.queue(filePath);
      await before.send({ ...request("%5", "survive"), label: "Fix it" });
      await before.send({ target: "%5", text: "no enter", enter: false, submitKey: "enter" });
      const cancelled = await before.send(request("%5", "cancelled"));
      before.cancel(cancelled!.id);
      await before.flush();

      const stored = parseTmuxSendQueueFile(await readFile(filePath, "utf8"));
      expect(stored.messages.map((message) => message.text)).toEqual(["survive", "no enter"]);

      const after = world.queue(filePath);
      await after.load();
      expect(after.list().map((message) => [message.text, message.label, message.enter])).toEqual([
        ["survive", "Fix it", true],
        ["no enter", undefined, false]
      ]);

      world.advance(1000);
      world.set("%5", "hax", "done", Math.floor(world.nowMs / 1000));
      await after.tick();
      expect(world.typed).toEqual([{ target: "%5", text: "survive", enter: true, submitKey: "enter" }]);
      await after.flush();
      expect(parseTmuxSendQueueFile(await readFile(filePath, "utf8")).messages.map((message) => message.text)).toEqual(["no enter"]);
    });

    it("keeps the in-flight send's tracking across a restart", async () => {
      world.set("%5", "hax", "idle", Math.floor(START_MS / 1000) - 60);
      const before = world.queue(filePath);
      await before.send(request("%5", "typed"));
      await before.send(request("%5", "held"));
      await before.flush();

      const after = world.queue(filePath);
      await after.load();
      world.advance(1000);
      await after.tick();
      expect(world.texts()).toEqual(["typed"]);
    });

    it("ignores a missing, corrupt or foreign file", () => {
      expect(parseTmuxSendQueueFile("").messages).toEqual([]);
      expect(parseTmuxSendQueueFile("{not json").messages).toEqual([]);
      expect(parseTmuxSendQueueFile(JSON.stringify({ version: 2, messages: [] })).messages).toEqual([]);
      const mixed = parseTmuxSendQueueFile(JSON.stringify({
        version: 1,
        messages: [
          { id: "a", target: "%5", agent: "hax", text: "ok", enter: true, submitKey: "enter", queuedAtMs: 1 },
          { id: "b", target: "%5", agent: "hax", text: "", enter: true, submitKey: "enter", queuedAtMs: 1 },
          { id: "c", target: "%5", agent: "hax", text: "bad key", enter: true, submitKey: "C-c", queuedAtMs: 1 },
          "junk"
        ],
        sent: { "%5": { sentAtMs: 5, sawWorking: true }, "%6": { sentAtMs: "x" } }
      }));
      expect(mixed.messages.map((message) => message.id)).toEqual(["a"]);
      expect([...mixed.sent]).toEqual([["%5", { sentAtMs: 5, sawWorking: true }]]);
    });
  });
});

describe("pane readiness", () => {
  const sentAtMs = START_MS;
  const sentSec = Math.floor(START_MS / 1000);

  it("is never ready while working, unknown or without a row", () => {
    expect(paneReadyForInput(undefined, sentSec, undefined)).toBe(false);
    expect(paneReadyForInput(agentRow("%5", "hax", "working"), sentSec, undefined)).toBe(false);
    expect(paneReadyForInput(agentRow("%5", "hax", "unknown"), sentSec, undefined)).toBe(false);
  });

  it("is ready when done, idle or blocked with nothing sent", () => {
    for (const status of ["done", "idle", "blocked"] as const) {
      expect(paneReadyForInput(agentRow("%5", "hax", status), sentSec, undefined)).toBe(true);
    }
  });

  it("after a send, needs the turn seen running, a newer idle_since, or a settled later snapshot", () => {
    const idle = agentRow("%5", "hax", "idle", sentSec - 30);
    expect(paneReadyForInput(idle, sentSec + 2, { sentAtMs, sawWorking: false })).toBe(false);
    expect(paneReadyForInput(idle, sentSec + 2, { sentAtMs, sawWorking: true })).toBe(true);
    expect(paneReadyForInput(agentRow("%5", "hax", "done", sentSec + 3), sentSec + 3, { sentAtMs, sawWorking: false })).toBe(true);
    expect(paneReadyForInput(idle, sentSec + SEND_SETTLE_MS / 1000, { sentAtMs, sawWorking: false })).toBe(true);
  });
});

describe("tmux send endpoints", () => {
  let server: http.Server;
  let baseUrl = "";
  let world: World;
  let queue: TmuxSendQueue;
  let keys: Array<{ session: string; key: string }> = [];
  let inputs: string[] = [];
  let submitted: Array<{ session: string; label: string | null }> = [];

  beforeEach(async () => {
    world = new World();
    queue = world.queue();
    keys = [];
    inputs = [];
    submitted = [];
    const app = express();
    app.use(express.json());
    app.use(createTmuxSendRouter({
      queue,
      resolveSubmitKey: async (_session, requested) => requested === "tab" ? "tab" : "enter",
      sendKey: async (session, key) => {
        keys.push({ session, key });
      },
      onInput: (session) => inputs.push(session),
      onSubmitted: (session, label) => submitted.push({ session, label })
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
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function call(method: string, url: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
    const response = await fetch(`${baseUrl}${url}`, {
      method,
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    return { status: response.status, json: await response.json() as Record<string, unknown> };
  }

  it("types into a ready pane and starts the watch", async () => {
    world.set("%1", "claude", "working");
    const result = await call("POST", "/api/tmux/send", { session: "%1", text: "  hello  ", label: "Task" });
    expect(result).toEqual({ status: 200, json: { ok: true } });
    expect(world.typed).toEqual([{ target: "%1", text: "hello", enter: true, submitKey: "enter" }]);
    expect(submitted).toEqual([{ session: "%1", label: "Task" }]);
    expect(inputs).toEqual(["%1"]);
  });

  it("answers with the held message for a working hax pane, lists it, and cancels it", async () => {
    world.set("%5", "hax", "working");
    const sent = await call("POST", "/api/tmux/send", { session: "%5", text: "later" });
    expect(sent.json).toEqual({ ok: true, queued: { id: "q1", text: "later", agent: "hax", queuedAtMs: START_MS } });
    expect(world.typed).toEqual([]);
    expect(submitted).toEqual([]);
    expect((await call("GET", "/api/tmux/queue?session=%255")).json).toEqual({ data: [{ id: "q1", text: "later", agent: "hax", queuedAtMs: START_MS }] });

    expect((await call("DELETE", "/api/tmux/queue/q1")).json).toEqual({ ok: true, cancelled: true });
    expect((await call("DELETE", "/api/tmux/queue/q1")).json).toEqual({ ok: true, cancelled: false });
    expect(queue.list()).toEqual([]);
  });

  it("sends key-strip keys straight through while hax works with messages held", async () => {
    world.set("%5", "hax", "working");
    await call("POST", "/api/tmux/send", { session: "%5", text: "held" });
    for (const key of ["Escape", "C-c", "Up"]) {
      expect((await call("POST", "/api/tmux/keys", { session: "%5", key })).json).toEqual({ ok: true });
    }
    expect(keys).toEqual([{ session: "%5", key: "Escape" }, { session: "%5", key: "C-c" }, { session: "%5", key: "Up" }]);
    expect(world.typed).toEqual([]);
    expect(queue.list().map((message) => message.text)).toEqual(["held"]);
  });

  it("rejects a send without text", async () => {
    const result = await call("POST", "/api/tmux/send", { session: "%5", text: "   " });
    expect(result.status).toBe(400);
    expect(world.typed).toEqual([]);
  });
});
