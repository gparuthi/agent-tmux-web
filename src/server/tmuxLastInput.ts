import { execFile } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { isTmuxRawSessionName } from "./terminal.js";

const execFileAsync = promisify(execFile);

export const DEFAULT_TMUX_LAST_INPUT_FILE = path.join(os.homedir(), ".local", "state", "atw", "last-input.json");
export const MAX_TMUX_LAST_INPUT_ENTRIES = 500;
const WRITE_DEBOUNCE_MS = 2000;

// client_activity is the client's last key input (not output); pane_id is the pane it is looking at.
export function buildTmuxClientActivityArgs(): string[] {
  return ["list-clients", "-F", "#{client_activity}\t#{pane_id}\t#{session_name}"];
}

// Latest owner keystroke per pane from real terminals; atw's own raw clients are skipped (counted at send time).
export function parseTmuxClientActivity(output: string): Map<string, number> {
  const latest = new Map<string, number>();
  for (const line of output.split(/\r?\n/)) {
    const [activity, paneId, sessionName] = line.split("\t");
    const atMs = Number(activity) * 1000;
    if (!paneId || !/^%\d+$/.test(paneId) || !Number.isFinite(atMs) || atMs <= 0 || !sessionName || isTmuxRawSessionName(sessionName)) {
      continue;
    }
    latest.set(paneId, Math.max(latest.get(paneId) ?? 0, atMs));
  }
  return latest;
}

export async function readTmuxClientActivity(): Promise<Map<string, number>> {
  try {
    const { stdout } = await execFileAsync("tmux", buildTmuxClientActivityArgs());
    return parseTmuxClientActivity(stdout);
  } catch {
    // No tmux server or no clients: nothing typed in a real terminal.
    return new Map();
  }
}

export function latestTmuxInputAtMs(...values: Array<number | undefined>): number | undefined {
  const known = values.filter((value): value is number => typeof value === "number" && value > 0);
  return known.length > 0 ? Math.max(...known) : undefined;
}

// Pane ids are reused after a tmux restart, so a record older than the pane belongs to a previous pane.
export function storedTmuxInputAtMs(stored: number | undefined, paneCreatedAtMs: number | undefined): number | undefined {
  return stored !== undefined && paneCreatedAtMs !== undefined && stored < paneCreatedAtMs ? undefined : stored;
}

export function parseTmuxLastInputFile(serialized: string): Map<string, number> {
  try {
    const value: unknown = JSON.parse(serialized);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return new Map();
    }
    return new Map(Object.entries(value).filter((entry): entry is [string, number] => (
      Boolean(entry[0]) && typeof entry[1] === "number" && Number.isFinite(entry[1]) && entry[1] > 0
    )));
  } catch {
    return new Map();
  }
}

// Keeps the newest entries so panes from old tmux servers do not pile up.
export function pruneTmuxLastInput(entries: Map<string, number>, maxEntries = MAX_TMUX_LAST_INPUT_ENTRIES): Map<string, number> {
  return new Map([...entries].sort((left, right) => right[1] - left[1]).slice(0, maxEntries));
}

// Last time atw sent input to each pane target; persisted with a debounced atomic write.
export class TmuxLastInputStore {
  private entries = new Map<string, number>();
  private writeTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly filePath: string | null,
    private readonly now: () => number = Date.now,
    private readonly debounceMs = WRITE_DEBOUNCE_MS
  ) {}

  async load(): Promise<void> {
    if (!this.filePath) {
      return;
    }
    const serialized = await readFile(this.filePath, "utf8").catch(() => "");
    for (const [target, atMs] of parseTmuxLastInputFile(serialized)) {
      this.entries.set(target, Math.max(this.entries.get(target) ?? 0, atMs));
    }
  }

  record(target: string): void {
    if (!target) {
      return;
    }
    this.entries.set(target, this.now());
    this.scheduleWrite();
  }

  get(target: string): number | undefined {
    return this.entries.get(target);
  }

  async flush(): Promise<void> {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
      this.writeTimer = null;
    }
    if (!this.filePath) {
      return;
    }
    this.entries = pruneTmuxLastInput(this.entries);
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
    await writeFile(temporaryPath, JSON.stringify(Object.fromEntries(this.entries)));
    await rename(temporaryPath, this.filePath);
  }

  private scheduleWrite(): void {
    if (!this.filePath || this.writeTimer) {
      return;
    }
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null;
      this.flush().catch((error: unknown) => console.error("Failed to save tmux last input times", error));
    }, this.debounceMs);
    this.writeTimer.unref();
  }
}
