import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { Router, type NextFunction, type Request, type Response } from "express";

import { resolveLocalTmuxPane, TmuxRequestError, type TmuxSession } from "./tmux.js";

const execFileAsync = promisify(execFile);

// A phone that stops polling (screen off, tab gone) counts as gone after this long.
export const AUTO_ZOOM_IDLE_MS = 60_000;
// After its /ws socket closes, a client gets this long to reconnect before its zoom is undone.
export const AUTO_ZOOM_DISCONNECT_GRACE_MS = 10_000;
export const AUTO_ZOOM_SWEEP_MS = 10_000;

export type TmuxRunner = (args: string[]) => Promise<string>;

export const runTmux: TmuxRunner = async (args) => (await execFileAsync("tmux", args)).stdout;

export type TmuxPaneZoomState = { windowId: string; windowPanes: number; zoomed: boolean; paneActive: boolean };

export function buildTmuxPaneZoomStateArgs(paneId: string): string[] {
  return ["display-message", "-p", "-t", paneId, "#{window_id}\t#{window_panes}\t#{window_zoomed_flag}\t#{pane_active}"];
}

export function buildTmuxToggleZoomArgs(paneId: string): string[] {
  return ["resize-pane", "-Z", "-t", paneId];
}

export function parseTmuxPaneZoomState(output: string): TmuxPaneZoomState | null {
  const [windowId = "", panes = "", zoomed = "", active = ""] = output.trim().split("\t");
  const windowPanes = Number(panes);
  if (!/^@\d+$/.test(windowId) || !Number.isInteger(windowPanes)) {
    return null;
  }
  return { windowId, windowPanes, zoomed: zoomed === "1", paneActive: active === "1" };
}

type AutoZoom = { paneId: string; windowId: string; clientId: string };

// The window atw zoomed is still zoomed on the pane atw zoomed.
function isStillZoomed(zoom: AutoZoom, state: TmuxPaneZoomState | null): boolean {
  return Boolean(state && state.windowId === zoom.windowId && state.zoomed && state.paneActive);
}
type ZoomClient = { lastSeenMs: number; sockets: number; disconnectedAtMs?: number };

export type TmuxAutoZoomOptions = {
  tmux?: TmuxRunner;
  now?: () => number;
  idleMs?: number;
  disconnectGraceMs?: number;
};

// Zooms a phone's selected pane when it shares its window, and undoes only zooms it made: when that
// phone moves on, disconnects or goes quiet, and only while the window is still zoomed on that pane.
export class TmuxAutoZoom {
  private readonly tmux: TmuxRunner;
  private readonly now: () => number;
  private readonly idleMs: number;
  private readonly disconnectGraceMs: number;
  private readonly zooms = new Map<string, AutoZoom>();
  private readonly clients = new Map<string, ZoomClient>();
  // One tmux change at a time, so a release and the next zoom can't interleave.
  private queue: Promise<unknown> = Promise.resolve();

  constructor({ tmux = runTmux, now = Date.now, idleMs = AUTO_ZOOM_IDLE_MS, disconnectGraceMs = AUTO_ZOOM_DISCONNECT_GRACE_MS }: TmuxAutoZoomOptions = {}) {
    this.tmux = tmux;
    this.now = now;
    this.idleMs = idleMs;
    this.disconnectGraceMs = disconnectGraceMs;
  }

  zoomedPanes(): string[] {
    return [...this.zooms.keys()];
  }

  seen(clientId: string): void {
    this.client(clientId).lastSeenMs = this.now();
  }

  socketOpened(clientId: string): void {
    const client = this.client(clientId);
    client.sockets += 1;
    client.lastSeenMs = this.now();
    delete client.disconnectedAtMs;
  }

  socketClosed(clientId: string): void {
    const client = this.clients.get(clientId);
    if (!client) {
      return;
    }
    client.sockets = Math.max(0, client.sockets - 1);
    if (client.sockets === 0) {
      client.disconnectedAtMs = this.now();
    }
  }

  // The client's selected pane is now paneId ("" for none or a pane atw can't zoom): undo this
  // client's zooms of other panes, then zoom paneId if its window is split and not zoomed yet.
  follow(clientId: string, paneId: string): Promise<boolean> {
    this.seen(clientId);
    return this.serialize(async () => {
      for (const zoom of [...this.zooms.values()]) {
        if (zoom.clientId === clientId && zoom.paneId !== paneId) {
          await this.undo(zoom);
        }
      }
      if (!paneId) {
        return false;
      }
      const state = await this.readState(paneId);
      if (!state || state.windowPanes < 2) {
        return false;
      }
      const ours = this.zooms.get(paneId);
      if (ours && !isStillZoomed(ours, state)) {
        this.zooms.delete(paneId);
      }
      if (state.zoomed) {
        // Still zoomed on our pane: keep it (and hand it to this client); anyone else's zoom stays theirs.
        if (ours && isStillZoomed(ours, state)) {
          this.zooms.set(paneId, { ...ours, clientId });
          return true;
        }
        return false;
      }
      await this.tmux(buildTmuxToggleZoomArgs(paneId));
      this.zooms.set(paneId, { paneId, windowId: state.windowId, clientId });
      return true;
    });
  }

  // Undoes the zooms of clients that disconnected or stopped polling, and forgets zooms the owner
  // already undid, so a later zoom of their own on that pane is never ours to undo.
  sweep(): Promise<void> {
    return this.serialize(async () => {
      const nowMs = this.now();
      for (const zoom of [...this.zooms.values()]) {
        const client = this.clients.get(zoom.clientId);
        const gone = !client
          || nowMs - client.lastSeenMs >= this.idleMs
          || (client.disconnectedAtMs !== undefined && nowMs - client.disconnectedAtMs >= this.disconnectGraceMs);
        if (gone) {
          await this.undo(zoom);
        } else if (!isStillZoomed(zoom, await this.readState(zoom.paneId))) {
          this.zooms.delete(zoom.paneId);
        }
      }
      for (const [clientId, client] of this.clients) {
        if (nowMs - client.lastSeenMs >= this.idleMs && client.sockets === 0 && ![...this.zooms.values()].some((zoom) => zoom.clientId === clientId)) {
          this.clients.delete(clientId);
        }
      }
    });
  }

  private client(clientId: string): ZoomClient {
    let client = this.clients.get(clientId);
    if (!client) {
      client = { lastSeenMs: this.now(), sockets: 0 };
      this.clients.set(clientId, client);
    }
    return client;
  }

  private async undo(zoom: AutoZoom): Promise<void> {
    this.zooms.delete(zoom.paneId);
    const state = await this.readState(zoom.paneId);
    // The owner unzoomed, zoomed another pane, or the pane moved or closed: not ours to undo.
    if (isStillZoomed(zoom, state)) {
      await this.tmux(buildTmuxToggleZoomArgs(zoom.paneId)).catch(() => undefined);
    }
  }

  private async readState(paneId: string): Promise<TmuxPaneZoomState | null> {
    try {
      return parseTmuxPaneZoomState(await this.tmux(buildTmuxPaneZoomStateArgs(paneId)));
    } catch {
      return null;
    }
  }

  private serialize<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => undefined);
    return run;
  }
}

export type TmuxAutoZoomRouterOptions = {
  autoZoom: TmuxAutoZoom;
  listPanes: () => Promise<TmuxSession[]>;
};

export function requireAutoZoomClientId(value: unknown): string {
  if (typeof value !== "string" || !/^[\w-]{1,100}$/.test(value)) {
    throw new TmuxRequestError("Missing or bad clientId");
  }
  return value;
}

// POST /api/tmux/auto-zoom {clientId, target}: a phone reports its selected pane; "" releases.
export function createTmuxAutoZoomRouter({ autoZoom, listPanes }: TmuxAutoZoomRouterOptions): Router {
  const router = Router();
  router.post("/api/tmux/auto-zoom", (req: Request, res: Response, next: NextFunction) => {
    (async () => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const clientId = requireAutoZoomClientId(body.clientId);
      const paneId = body.target === "" ? "" : resolveLocalTmuxPane(await listPanes(), body.target).name;
      res.json({ data: { zoomed: await autoZoom.follow(clientId, paneId) } });
    })().catch(next);
  });
  return router;
}
