import http from "node:http";
import type { AddressInfo } from "node:net";

import express, { type NextFunction, type Request, type Response } from "express";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { TerminalSize } from "../terminal.js";
import type { TmuxSession } from "../tmux.js";
import type { TmuxRunner } from "../tmuxAutoZoom.js";
import {
  buildTmuxWindowWidthArgs,
  createTmuxViewSizeRouter,
  TmuxViewSize,
  type TmuxViewTarget
} from "../tmuxViewSize.js";

type FakeClient = { command: string; size: TerminalSize; resizes: TerminalSize[]; closed: boolean; exit: () => void };

function setup(nowMs = { value: 0 }) {
  const clients: FakeClient[] = [];
  const killed: string[] = [];
  const tmuxCalls: string[][] = [];
  const windowWidths: Record<string, number> = { "@1": 47, "@2": 47 };
  let counter = 0;
  const tmux: TmuxRunner = async (args) => {
    tmuxCalls.push(args);
    if (args[0] === "display-message") {
      return `${windowWidths[args[3] ?? ""] ?? ""}\n`;
    }
    throw new Error(`unexpected tmux ${args.join(" ")}`);
  };
  const viewSize = new TmuxViewSize({
    tmux,
    now: () => nowMs.value,
    idleMs: 60_000,
    newSessionName: () => `atw-raw-view${++counter}`,
    killSession: async (session) => { killed.push(session); },
    start: (command, size, onExit) => {
      const client: FakeClient = { command, size, resizes: [], closed: false, exit: onExit };
      clients.push(client);
      return {
        resize: async (next) => { client.resizes.push(next); },
        close: () => { client.closed = true; }
      };
    }
  });
  return { viewSize, clients, killed, tmuxCalls, windowWidths, nowMs };
}

const target = (paneId: string, windowId: string): TmuxViewTarget => ({ paneId, windowId, baseSession: "main" });
const phone = { cols: 47, rows: 50 };

describe("TmuxViewSize leases", () => {
  it("attaches a grouped client at the phone's size, not read-only, and never runs resize-window", async () => {
    const { viewSize, clients, tmuxCalls } = setup();
    expect(await viewSize.follow("phone", target("%1", "@1"), phone)).toEqual({ applied: true, cols: 47 });

    expect(clients).toHaveLength(1);
    expect(clients[0]!.size).toEqual(phone);
    expect(clients[0]!.command).toContain("stty cols 47 rows 50;");
    expect(clients[0]!.command).toContain("-f active-pane -t main -s atw-raw-view1");
    expect(clients[0]!.command).not.toContain("read-only");
    expect(clients[0]!.command).toContain("select-window -t atw-raw-view1:@1");
    expect([...clients.map((client) => client.command), ...tmuxCalls.map((args) => args.join(" "))].some((text) => text.includes("resize-window"))).toBe(false);
  });

  it("resizes an existing lease's pty instead of attaching again", async () => {
    const { viewSize, clients, killed } = setup();
    await viewSize.follow("phone", target("%1", "@1"), phone);
    expect(await viewSize.follow("phone", target("%1", "@1"), { cols: 52, rows: 50 })).toEqual({ applied: true, cols: 52 });
    expect(clients).toHaveLength(1);
    expect(clients[0]!.resizes).toEqual([{ cols: 52, rows: 50 }]);
    expect(killed).toEqual([]);
  });

  it("keeps one lease per client, replacing it when the pane changes", async () => {
    const { viewSize, clients, killed } = setup();
    await viewSize.follow("phone", target("%1", "@1"), phone);
    await viewSize.follow("phone", target("%3", "@2"), phone);

    expect(clients).toHaveLength(2);
    expect(clients[0]!.closed).toBe(true);
    expect(killed).toEqual(["atw-raw-view1"]);
    expect(viewSize.leasedPanes()).toEqual(["%3"]);
  });

  it("gives a window to one client only", async () => {
    const { viewSize, clients } = setup();
    await viewSize.follow("phone", target("%1", "@1"), phone);
    expect(await viewSize.follow("tablet", target("%2", "@1"), phone)).toEqual({ applied: false });
    expect(clients).toHaveLength(1);
    expect(await viewSize.follow("tablet", target("%3", "@2"), phone)).toEqual({ applied: true, cols: 47 });
    expect(viewSize.leasedPanes().sort()).toEqual(["%1", "%3"]);
  });

  it("releases on request and lets the next client take the window", async () => {
    const { viewSize, clients, killed } = setup();
    await viewSize.follow("phone", target("%1", "@1"), phone);
    await viewSize.release("phone");
    expect(killed).toEqual(["atw-raw-view1"]);
    expect(clients[0]!.closed).toBe(true);
    expect(await viewSize.follow("tablet", target("%1", "@1"), phone)).toEqual({ applied: true, cols: 47 });
    await viewSize.follow("tablet", null, phone);
    expect(viewSize.leasedPanes()).toEqual([]);
  });

  it("sweeps leases of phones that stopped polling, and seen() keeps one alive", async () => {
    const { viewSize, killed, nowMs } = setup();
    await viewSize.follow("phone", target("%1", "@1"), phone);
    await viewSize.follow("quiet", target("%3", "@2"), phone);
    nowMs.value = 50_000;
    viewSize.seen("phone");
    nowMs.value = 70_000;
    await viewSize.sweep();
    expect(killed).toEqual(["atw-raw-view2"]);
    expect(viewSize.leasedPanes()).toEqual(["%1"]);
    nowMs.value = 110_000;
    await viewSize.sweep();
    expect(killed).toEqual(["atw-raw-view2", "atw-raw-view1"]);
    expect(viewSize.leasedPanes()).toEqual([]);
  });

  it("drops a lease whose tmux client exited and kills its grouped session", async () => {
    const { viewSize, clients, killed } = setup();
    await viewSize.follow("phone", target("%1", "@1"), phone);
    clients[0]!.exit();
    expect(viewSize.leasedPanes()).toEqual([]);
    expect(killed).toEqual(["atw-raw-view1"]);
  });

  it("replaces a lease the desktop took back on retake, and leaves a current one alone", async () => {
    const { viewSize, clients, killed, windowWidths, tmuxCalls } = setup();
    await viewSize.follow("phone", target("%1", "@1"), phone);
    await viewSize.follow("phone", target("%1", "@1"), phone, true);
    expect(clients).toHaveLength(1);
    expect(tmuxCalls).toEqual([buildTmuxWindowWidthArgs("@1")]);

    windowWidths["@1"] = 150;
    expect(await viewSize.follow("phone", target("%1", "@1"), phone, true)).toEqual({ applied: true, cols: 47 });
    expect(clients).toHaveLength(2);
    expect(killed).toEqual(["atw-raw-view1"]);
    expect(clients[1]!.command).toContain("-f active-pane -t main -s atw-raw-view2");
    // Without retake a lease is never replaced, so a debounced resize can't fight the desktop.
    await viewSize.follow("phone", target("%1", "@1"), phone);
    expect(clients).toHaveLength(2);
  });
});

describe("tmux view-size endpoint", () => {
  const pane = (name: string, windowId: string, session = "main"): TmuxSession => ({
    name,
    session,
    paneId: name.match(/%\d+$/)?.[0],
    windowId,
    windows: 1,
    created: "",
    attached: false,
    clientCount: 0
  });
  let server: http.Server;
  let baseUrl = "";
  let state: ReturnType<typeof setup>;
  let raw = new Set<string>();

  beforeEach(async () => {
    state = setup();
    raw = new Set();
    const app = express();
    app.use(express.json());
    app.use(createTmuxViewSizeRouter({
      viewSize: state.viewSize,
      listPanes: async () => [pane("%1", "@1"), pane("%2", "@2"), pane("dk--box--%4", "@9", "dk--box--work")],
      rawActive: (clientId) => raw.has(clientId)
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

  async function post(body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
    const response = await fetch(`${baseUrl}/api/tmux/view-size`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    return { status: response.status, json: await response.json() as Record<string, unknown> };
  }

  it("leases a listed local pane at the clamped size and releases on an empty target", async () => {
    expect(await post({ clientId: "phone-1", target: "%1", cols: 47, rows: 50 })).toEqual({ status: 200, json: { data: { applied: true, cols: 47 } } });
    expect(state.clients[0]!.size).toEqual({ cols: 47, rows: 50 });
    expect(await post({ clientId: "phone-1", target: "", cols: 47, rows: 50 })).toEqual({ status: 200, json: { data: { applied: false } } });
    expect(state.killed).toEqual(["atw-raw-view1"]);
    expect((await post({ clientId: "phone-2", target: "%2", cols: 3, rows: 500 })).json).toEqual({ data: { applied: true, cols: 20 } });
    expect(state.clients[1]!.size).toEqual({ cols: 20, rows: 80 });
  });

  it("rejects bad input and shim-routed panes", async () => {
    expect((await post({ clientId: "bad id!", target: "%1", cols: 47, rows: 50 })).status).toBe(400);
    expect((await post({ clientId: "phone", target: "%1", cols: "wide", rows: 50 })).status).toBe(400);
    expect((await post({ clientId: "phone", target: "%99", cols: 47, rows: 50 })).status).toBe(400);
    expect((await post({ clientId: "phone", target: "dk--box--%4", cols: 47, rows: 50 })).status).toBe(400);
    expect(state.clients).toHaveLength(0);
  });

  it("does not lease for a client with a Raw terminal open, and ends the one it had", async () => {
    await post({ clientId: "phone", target: "%1", cols: 47, rows: 50 });
    raw.add("phone");
    expect(await post({ clientId: "phone", target: "%1", cols: 47, rows: 50 })).toEqual({ status: 200, json: { data: { applied: false } } });
    expect(state.viewSize.leasedPanes()).toEqual([]);
  });
});
