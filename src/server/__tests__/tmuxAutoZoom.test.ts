import http from "node:http";
import type { AddressInfo } from "node:net";

import express, { type NextFunction, type Request, type Response } from "express";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { TmuxSession } from "../tmux.js";
import {
  buildTmuxPaneZoomStateArgs,
  buildTmuxToggleZoomArgs,
  createTmuxAutoZoomRouter,
  parseTmuxPaneZoomState,
  TmuxAutoZoom,
  type TmuxRunner
} from "../tmuxAutoZoom.js";

type FakeWindow = { panes: string[]; active: string; zoomed: boolean };

// An in-memory tmux that answers the zoom-state query and toggles zoom like resize-pane -Z.
function fakeTmux(windows: Record<string, FakeWindow>) {
  const calls: string[][] = [];
  const windowOf = (paneId: string) => Object.entries(windows).find(([, window]) => window.panes.includes(paneId));
  const run: TmuxRunner = async (args) => {
    calls.push(args);
    const paneId = args[args.indexOf("-t") + 1] ?? "";
    const found = windowOf(paneId);
    if (!found) {
      throw new Error(`can't find pane: ${paneId}`);
    }
    const [windowId, window] = found;
    if (args[0] === "display-message") {
      return `${windowId}\t${window.panes.length}\t${window.zoomed ? 1 : 0}\t${window.active === paneId ? 1 : 0}\n`;
    }
    if (args[0] === "resize-pane" && args[1] === "-Z") {
      window.zoomed = !window.zoomed && window.panes.length > 1;
      window.active = paneId;
      return "";
    }
    throw new Error(`unexpected tmux ${args.join(" ")}`);
  };
  const zooms = () => calls.filter((args) => args[0] === "resize-pane").map((args) => args[3]);
  return { run, calls, zooms };
}

function setup(nowMs = { value: 0 }) {
  const windows: Record<string, FakeWindow> = {
    "@1": { panes: ["%1", "%2"], active: "%2", zoomed: false },
    "@2": { panes: ["%3"], active: "%3", zoomed: false },
    "@3": { panes: ["%4", "%5"], active: "%4", zoomed: false }
  };
  const tmux = fakeTmux(windows);
  const autoZoom = new TmuxAutoZoom({ tmux: tmux.run, now: () => nowMs.value, idleMs: 60_000, disconnectGraceMs: 10_000 });
  return { windows, tmux, autoZoom, nowMs };
}

describe("tmux auto-zoom helpers", () => {
  it("builds argv for the zoom state and the zoom toggle", () => {
    expect(buildTmuxPaneZoomStateArgs("%4")).toEqual(["display-message", "-p", "-t", "%4", "#{window_id}\t#{window_panes}\t#{window_zoomed_flag}\t#{pane_active}"]);
    expect(buildTmuxToggleZoomArgs("%4")).toEqual(["resize-pane", "-Z", "-t", "%4"]);
  });

  it("parses the zoom state", () => {
    expect(parseTmuxPaneZoomState("@7\t2\t1\t0\n")).toEqual({ windowId: "@7", windowPanes: 2, zoomed: true, paneActive: false });
    expect(parseTmuxPaneZoomState("")).toBeNull();
    expect(parseTmuxPaneZoomState("@7\tx\t1\t1")).toBeNull();
  });
});

describe("tmux auto-zoom bookkeeping", () => {
  it("zooms a pane that shares its window, never a lone pane", async () => {
    const { windows, tmux, autoZoom } = setup();
    expect(await autoZoom.follow("phone", "%1")).toBe(true);
    expect(windows["@1"]).toMatchObject({ zoomed: true, active: "%1" });
    expect(await autoZoom.follow("phone", "%3")).toBe(false);
    expect(tmux.zooms()).toEqual(["%1", "%1"]);
    expect(windows["@1"]!.zoomed).toBe(false);
    expect(autoZoom.zoomedPanes()).toEqual([]);
  });

  it("leaves a window the owner already zoomed alone, and never unzooms it", async () => {
    const { windows, tmux, autoZoom } = setup();
    windows["@1"]!.zoomed = true;
    expect(await autoZoom.follow("phone", "%2")).toBe(false);
    await autoZoom.follow("phone", "");
    expect(tmux.zooms()).toEqual([]);
    expect(windows["@1"]).toMatchObject({ zoomed: true, active: "%2" });
  });

  it("unzooms when the phone selects a pane in the same window, then zooms that one", async () => {
    const { windows, tmux, autoZoom } = setup();
    await autoZoom.follow("phone", "%1");
    expect(await autoZoom.follow("phone", "%2")).toBe(true);
    expect(tmux.zooms()).toEqual(["%1", "%1", "%2"]);
    expect(windows["@1"]).toMatchObject({ zoomed: true, active: "%2" });
    expect(autoZoom.zoomedPanes()).toEqual(["%2"]);
  });

  it("does not unzoom after the owner unzoomed or zoomed another pane", async () => {
    const { windows, tmux, autoZoom } = setup();
    await autoZoom.follow("phone", "%1");
    windows["@1"]!.zoomed = false;
    await autoZoom.follow("phone", "%3");
    await autoZoom.follow("phone", "%4");
    windows["@3"]!.zoomed = true;
    windows["@3"]!.active = "%5";
    await autoZoom.follow("phone", "");
    expect(tmux.zooms()).toEqual(["%1", "%4"]);
    expect(windows["@1"]!.zoomed).toBe(false);
    expect(windows["@3"]).toMatchObject({ zoomed: true, active: "%5" });
  });

  it("forgets a zoom the owner undid, so their own later zoom of that pane survives", async () => {
    const { windows, tmux, autoZoom } = setup();
    await autoZoom.follow("phone", "%1");
    windows["@1"]!.zoomed = false;
    await autoZoom.sweep();
    windows["@1"]!.zoomed = true;
    await autoZoom.follow("phone", "");
    expect(tmux.zooms()).toEqual(["%1"]);
    expect(windows["@1"]!.zoomed).toBe(true);
  });

  it("keeps the zoom when the phone re-sends the same pane", async () => {
    const { tmux, autoZoom } = setup();
    await autoZoom.follow("phone", "%1");
    expect(await autoZoom.follow("phone", "%1")).toBe(true);
    expect(tmux.zooms()).toEqual(["%1"]);
  });

  it("leaves other clients' zooms alone", async () => {
    const { windows, autoZoom } = setup();
    await autoZoom.follow("phone-a", "%1");
    await autoZoom.follow("phone-b", "%4");
    await autoZoom.follow("phone-b", "%3");
    expect(windows["@1"]!.zoomed).toBe(true);
    expect(windows["@3"]!.zoomed).toBe(false);
  });

  it("unzooms after the phone stops polling for the idle window", async () => {
    const { windows, autoZoom, nowMs } = setup();
    await autoZoom.follow("phone", "%1");
    nowMs.value = 59_000;
    await autoZoom.sweep();
    expect(windows["@1"]!.zoomed).toBe(true);
    autoZoom.seen("phone");
    nowMs.value = 118_000;
    await autoZoom.sweep();
    expect(windows["@1"]!.zoomed).toBe(true);
    nowMs.value = 119_000;
    await autoZoom.sweep();
    expect(windows["@1"]!.zoomed).toBe(false);
    expect(autoZoom.zoomedPanes()).toEqual([]);
  });

  it("unzooms shortly after the phone's socket closes, unless it reconnects", async () => {
    const { windows, autoZoom, nowMs } = setup();
    autoZoom.socketOpened("phone");
    await autoZoom.follow("phone", "%1");
    autoZoom.socketClosed("phone");
    nowMs.value = 5_000;
    autoZoom.socketOpened("phone");
    nowMs.value = 20_000;
    await autoZoom.sweep();
    expect(windows["@1"]!.zoomed).toBe(true);
    autoZoom.socketClosed("phone");
    nowMs.value = 29_000;
    await autoZoom.sweep();
    expect(windows["@1"]!.zoomed).toBe(true);
    nowMs.value = 30_000;
    await autoZoom.sweep();
    expect(windows["@1"]!.zoomed).toBe(false);
  });

  it("drops a zoom whose pane closed without touching tmux", async () => {
    const { windows, tmux, autoZoom } = setup();
    await autoZoom.follow("phone", "%1");
    windows["@1"] = { panes: ["%2"], active: "%2", zoomed: false };
    await autoZoom.follow("phone", "%3");
    expect(tmux.zooms()).toEqual(["%1"]);
    expect(autoZoom.zoomedPanes()).toEqual([]);
  });
});

describe("tmux auto-zoom endpoint", () => {
  const pane = (name: string, session: string): TmuxSession => ({
    name,
    session,
    paneId: name.match(/%\d+$/)?.[0],
    windows: 1,
    created: "",
    attached: false,
    clientCount: 0
  });
  let server: http.Server;
  let baseUrl = "";
  let state: ReturnType<typeof setup>;

  beforeEach(async () => {
    state = setup();
    const app = express();
    app.use(express.json());
    app.use(createTmuxAutoZoomRouter({
      autoZoom: state.autoZoom,
      listPanes: async () => [pane("%1", "main"), pane("%2", "main"), pane("%3", "gp"), pane("dk--box--%4", "dk--box--work")]
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
    const response = await fetch(`${baseUrl}/api/tmux/auto-zoom`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    return { status: response.status, json: await response.json() as Record<string, unknown> };
  }

  it("zooms a listed local pane and releases it on an empty target", async () => {
    expect(await post({ clientId: "phone-1", target: "%1" })).toEqual({ status: 200, json: { data: { zoomed: true } } });
    expect(state.windows["@1"]!.zoomed).toBe(true);
    expect(await post({ clientId: "phone-1", target: "" })).toEqual({ status: 200, json: { data: { zoomed: false } } });
    expect(state.windows["@1"]!.zoomed).toBe(false);
    expect(state.tmux.zooms()).toEqual(["%1", "%1"]);
  });

  it("rejects unlisted, remote or malformed targets and bad client ids before touching tmux", async () => {
    for (const target of ["%99", "main", "dk--box--%4", "%1 ", null, 1]) {
      const result = await post({ clientId: "phone-1", target });
      expect(result.status, String(target)).toBe(400);
      expect(String(result.json.error)).toMatch(/Unknown tmux pane/);
    }
    for (const clientId of [undefined, "", "a b", "x".repeat(101), 7]) {
      expect((await post({ clientId, target: "%1" })).status, String(clientId)).toBe(400);
    }
    expect(state.tmux.calls).toEqual([]);
  });
});
