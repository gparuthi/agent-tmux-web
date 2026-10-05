import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { runTmux, type TmuxRunner } from "./tmuxAutoZoom.js";

export const DEFAULT_TMUX_RESIZED_WINDOWS_FILE = path.join(os.homedir(), ".local", "state", "atw", "resized-windows.json");
export const WINDOW_SIZE_HEAL_MS = 60_000;

// A window atw resized, pinned to the tmux server (pid) and window it was on so recycled ids are never touched.
export type TrackedTmuxWindow = { target: string; serverPid: string; windowId: string };

export function buildTmuxWindowIdentityArgs(target: string): string[] {
  return ["display-message", "-p", "-t", target, "#{pid}\t#{window_id}"];
}

// Without -A this reads the window's own value: "manual" only when pinned on the window, not inherited.
export function buildTmuxShowWindowSizeOptionArgs(target: string): string[] {
  return ["show-window-options", "-v", "-t", target, "window-size"];
}

// resize-window (even -A) sets window-size manual, so the unset must come last to leave the window unpinned.
export function buildTmuxUnpinWindowSizeCommandSequence(target: string): string[][] {
  return [
    ["resize-window", "-A", "-t", target],
    ["set-window-option", "-u", "-t", target, "window-size"]
  ];
}

export function parseTmuxWindowIdentity(output: string): { serverPid: string; windowId: string } | null {
  const [serverPid = "", windowId = ""] = output.trim().split("\t");
  return /^\d+$/.test(serverPid) && /^@\d+$/.test(windowId) ? { serverPid, windowId } : null;
}

export function parseTrackedTmuxWindowsFile(serialized: string): TrackedTmuxWindow[] {
  try {
    const value: unknown = JSON.parse(serialized);
    if (!Array.isArray(value)) {
      return [];
    }
    return value.filter((entry): entry is TrackedTmuxWindow => (
      Boolean(entry) && typeof entry === "object"
      && typeof entry.target === "string" && Boolean(entry.target)
      && typeof entry.serverPid === "string" && typeof entry.windowId === "string"
    )).map(({ target, serverPid, windowId }) => ({ target, serverPid, windowId }));
  } catch {
    return [];
  }
}

function trackedKey(entry: TrackedTmuxWindow): string {
  return `${entry.serverPid}\t${entry.windowId}`;
}

export type TmuxWindowSizeGuardOptions = {
  filePath: string | null;
  tmux?: TmuxRunner;
};

// Remembers windows atw resized and unpins them if they are left at window-size manual; never touches others.
export class TmuxWindowSizeGuard {
  private readonly filePath: string | null;
  private readonly tmux: TmuxRunner;
  private readonly entries = new Map<string, TrackedTmuxWindow>();
  // One sweep or record at a time, so a heal can't race the state file write.
  private queue: Promise<unknown> = Promise.resolve();

  constructor({ filePath, tmux = runTmux }: TmuxWindowSizeGuardOptions) {
    this.filePath = filePath;
    this.tmux = tmux;
  }

  async load(): Promise<void> {
    if (!this.filePath) {
      return;
    }
    const serialized = await readFile(this.filePath, "utf8").catch(() => "");
    for (const entry of parseTrackedTmuxWindowsFile(serialized)) {
      this.entries.set(trackedKey(entry), entry);
    }
  }

  tracked(): TrackedTmuxWindow[] {
    return [...this.entries.values()];
  }

  // Call before any resize-window, so a crash between the resize and its unpin is still healed.
  track(target: string): Promise<void> {
    return this.serialize(async () => {
      const identity = parseTmuxWindowIdentity(await this.tmux(buildTmuxWindowIdentityArgs(target)));
      if (!identity) {
        return;
      }
      const entry = { target, ...identity };
      this.entries.set(trackedKey(entry), entry);
      await this.save();
    });
  }

  // Unpins tracked windows left at manual; forgets a window only once it, or its tmux server, is gone.
  heal(): Promise<void> {
    return this.serialize(async () => {
      let changed = false;
      for (const [key, entry] of this.entries) {
        if (!await this.healWindow(entry).catch(() => true)) {
          this.entries.delete(key);
          changed = true;
        }
      }
      if (changed) {
        await this.save();
      }
    });
  }

  // False when the window is gone; tmux errors after that keep it tracked for the next sweep.
  private async healWindow(entry: TrackedTmuxWindow): Promise<boolean> {
    const identity = await this.tmux(buildTmuxWindowIdentityArgs(entry.target))
      .then(parseTmuxWindowIdentity)
      .catch(() => null);
    if (!identity || identity.serverPid !== entry.serverPid || identity.windowId !== entry.windowId) {
      // Window, server or the pane we targeted it by is gone; its ids may now belong to someone else's window.
      return false;
    }
    const option = (await this.tmux(buildTmuxShowWindowSizeOptionArgs(entry.target))).trim();
    if (option === "manual") {
      for (const args of buildTmuxUnpinWindowSizeCommandSequence(entry.target)) {
        await this.tmux(args);
      }
    }
    return true;
  }

  private async save(): Promise<void> {
    if (!this.filePath) {
      return;
    }
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
    await writeFile(temporaryPath, JSON.stringify(this.tracked()));
    await rename(temporaryPath, this.filePath);
  }

  private serialize<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => undefined);
    return run;
  }
}
