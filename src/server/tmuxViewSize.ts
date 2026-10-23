import { randomBytes } from "node:crypto";

import { Router, type NextFunction, type Request, type Response } from "express";

import { killTmuxSessionQuietly, resolveLocalTmuxPane, TmuxRequestError, type TmuxSession } from "./tmux.js";
import { requireAutoZoomClientId, runTmux, type TmuxRunner } from "./tmuxAutoZoom.js";
import {
  buildTmuxGroupedAttachShellCommand,
  closeTerminalChild,
  findRawTerminalPty,
  normalizeTerminalSize,
  resizeTerminalPty,
  spawnTmuxScriptClient,
  TMUX_VIEW_SESSION_PREFIX,
  type TerminalSize
} from "./terminal.js";

// A browser that stops polling (screen off, tab hidden or gone) counts as gone after this long.
export const VIEW_SIZE_IDLE_MS = 60_000;
export const VIEW_SIZE_SWEEP_MS = 10_000;

// A running tmux client on its own pty; resizing it is a client resize to tmux, never resize-window.
export type TmuxViewClient = {
  resize: (size: TerminalSize) => Promise<void>;
  close: () => void;
};

export type StartTmuxViewClient = (command: string, size: TerminalSize, onExit: () => void) => TmuxViewClient;

export const startTmuxViewClient: StartTmuxViewClient = (command, size, onExit) => {
  const child = spawnTmuxScriptClient(command, size);
  // The client paints into its pty; an unread pipe would stall it.
  child.stdout.resume();
  child.stderr.resume();
  child.on("error", onExit);
  child.on("exit", () => {
    // Lets the darwin stdin relay (cat) see EOF and exit.
    child.stdin.destroy();
    onExit();
  });
  let tty: string | null = null;
  return {
    resize: async (next) => {
      tty ??= await findRawTerminalPty(child.pid);
      if (tty) {
        await resizeTerminalPty(tty, next);
      }
    },
    close: () => closeTerminalChild(child)
  };
};

// What a lease needs to know about the pane it sizes; resolved from the pane list by the caller.
export type TmuxViewTarget = { paneId: string; windowId: string; baseSession: string };

type Lease = TmuxViewTarget & {
  clientId: string;
  rawSession: string;
  client: TmuxViewClient;
  size: TerminalSize;
  lastSeenMs: number;
};

export type TmuxViewSizeResult = { applied: boolean; cols?: number };

export function buildTmuxWindowWidthArgs(windowId: string): string[] {
  return ["display-message", "-p", "-t", windowId, "#{window_width}"];
}

export type TmuxViewSizeOptions = {
  tmux?: TmuxRunner;
  start?: StartTmuxViewClient;
  killSession?: (session: string) => Promise<void>;
  now?: () => number;
  idleMs?: number;
  newSessionName?: () => string;
};

// While a phone views a pane in TTY, holds a tmux client at the phone's width so the window
// (window-size latest) shrinks to it for the agent to wrap there. The window is never pinned: leases end
// when the phone leaves, goes quiet or opens Raw, and the grouped session is killed with them.
export class TmuxViewSize {
  private readonly tmux: TmuxRunner;
  private readonly start: StartTmuxViewClient;
  private readonly killSession: (session: string) => Promise<void>;
  private readonly now: () => number;
  private readonly idleMs: number;
  private readonly newSessionName: () => string;
  private readonly leases = new Map<string, Lease>();
  // One tmux change at a time, so a release and the next lease can't interleave.
  private queue: Promise<unknown> = Promise.resolve();

  constructor({
    tmux = runTmux,
    start = startTmuxViewClient,
    killSession = killTmuxSessionQuietly,
    now = Date.now,
    idleMs = VIEW_SIZE_IDLE_MS,
    newSessionName = () => `${TMUX_VIEW_SESSION_PREFIX}${randomBytes(4).toString("hex")}`
  }: TmuxViewSizeOptions = {}) {
    this.tmux = tmux;
    this.start = start;
    this.killSession = killSession;
    this.now = now;
    this.idleMs = idleMs;
    this.newSessionName = newSessionName;
  }

  leasedPanes(): string[] {
    return [...this.leases.values()].map((lease) => lease.paneId);
  }

  seen(clientId: string): void {
    const lease = this.leases.get(clientId);
    if (lease) {
      lease.lastSeenMs = this.now();
    }
  }

  // The client views `target` at `size` (null releases). A window another client already leases stays
  // that client's unless this is a retake; otherwise this one gets applied:false and keeps its scroll
  // fallback. `retake` means the browser
  // just selected the pane or came back: a client that typed since took the window (a pty resize does
  // not win it back), so a lease whose window is no longer at its width is replaced by a fresh attach.
  follow(clientId: string, target: TmuxViewTarget | null, size: TerminalSize, retake = false): Promise<TmuxViewSizeResult> {
    return this.serialize(async () => {
      let lease = this.leases.get(clientId);
      if (lease && (!target || lease.paneId !== target.paneId)) {
        await this.end(lease);
        lease = undefined;
      }
      if (!target) {
        return { applied: false };
      }
      if (lease && retake && await this.windowWidth(lease.windowId) !== lease.size.cols) {
        await this.end(lease);
        lease = undefined;
      }
      if (lease) {
        lease.lastSeenMs = this.now();
        if (lease.size.cols !== size.cols || lease.size.rows !== size.rows) {
          await lease.client.resize(size).catch(() => undefined);
          lease.size = size;
        }
        return { applied: true, cols: lease.size.cols };
      }
      const holder = [...this.leases.values()].find((other) => other.windowId === target.windowId);
      if (holder && !retake) {
        return { applied: false };
      }
      // The browser the owner just picked or came back to wins over one left open elsewhere.
      if (holder) {
        await this.end(holder);
      }
      return { applied: this.attach(clientId, target, size), cols: size.cols };
    });
  }

  release(clientId: string): Promise<void> {
    return this.serialize(async () => {
      const lease = this.leases.get(clientId);
      if (lease) {
        await this.end(lease);
      }
    });
  }

  // Ends the leases of browsers that stopped polling.
  sweep(): Promise<void> {
    return this.serialize(async () => {
      const nowMs = this.now();
      for (const lease of [...this.leases.values()]) {
        if (nowMs - lease.lastSeenMs >= this.idleMs) {
          await this.end(lease);
        }
      }
    });
  }

  private async windowWidth(windowId: string): Promise<number | null> {
    try {
      const width = Number((await this.tmux(buildTmuxWindowWidthArgs(windowId))).trim());
      return Number.isInteger(width) ? width : null;
    } catch {
      return null;
    }
  }

  private attach(clientId: string, target: TmuxViewTarget, size: TerminalSize): boolean {
    const rawSession = this.newSessionName();
    const command = buildTmuxGroupedAttachShellCommand(
      { baseSession: target.baseSession, rawSession, windowId: target.windowId, paneId: target.paneId },
      // Not read-only: tmux routes atw's send-keys through this client and refuses a read-only one; its pty gets no input.
      {},
      size
    );
    let client: TmuxViewClient;
    try {
      client = this.start(command, size, () => {
        // tmux or its pty went away (pane closed, server restarted): the lease is over.
        if (this.leases.get(clientId)?.rawSession === rawSession) {
          this.leases.delete(clientId);
          void this.killSession(rawSession);
        }
      });
    } catch {
      return false;
    }
    this.leases.set(clientId, { ...target, clientId, rawSession, client, size, lastSeenMs: this.now() });
    return true;
  }

  private async end(lease: Lease): Promise<void> {
    if (this.leases.get(lease.clientId) === lease) {
      this.leases.delete(lease.clientId);
    }
    // Killing the grouped session detaches the client, which is what returns the window to the other clients.
    await this.killSession(lease.rawSession);
    lease.client.close();
  }

  private serialize<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => undefined);
    return run;
  }
}

export type TmuxViewSizeRouterOptions = {
  viewSize: TmuxViewSize;
  listPanes: () => Promise<TmuxSession[]>;
  // A phone with a Raw terminal open sizes the window through that client instead.
  rawActive?: (clientId: string) => boolean;
};

function requireDimension(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TmuxRequestError(`Missing or bad ${name}`);
  }
  return value;
}

// POST /api/tmux/view-size {clientId, target, cols, rows, retake}: a phone viewing `target` in TTY reports the
// columns that fit its screen; "" releases.
export function createTmuxViewSizeRouter({ viewSize, listPanes, rawActive }: TmuxViewSizeRouterOptions): Router {
  const router = Router();
  router.post("/api/tmux/view-size", (req: Request, res: Response, next: NextFunction) => {
    (async () => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const clientId = requireAutoZoomClientId(body.clientId);
      if (body.target === "" || rawActive?.(clientId)) {
        await viewSize.release(clientId);
        res.json({ data: { applied: false } satisfies TmuxViewSizeResult });
        return;
      }
      const size = normalizeTerminalSize(requireDimension(body.cols, "cols"), requireDimension(body.rows, "rows"));
      const pane = resolveLocalTmuxPane(await listPanes(), body.target);
      const target = pane.session && pane.windowId && pane.paneId
        ? { paneId: pane.paneId, windowId: pane.windowId, baseSession: pane.session }
        : null;
      res.json({ data: await viewSize.follow(clientId, target, size, body.retake === true) });
    })().catch(next);
  });
  return router;
}
