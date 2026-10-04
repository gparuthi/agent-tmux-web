import { execFile } from "node:child_process";
import { open, readdir, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const DEFAULT_CLAUDE_CONFIG_DIR = path.join(os.homedir(), ".claude");
const TRANSCRIPT_TAIL_BYTES = 512 * 1024;
const REFRESH_INTERVAL_MS = 10_000;
const REFRESH_TIMEOUT_MS = 3000;

export type ClaudeSessionFile = {
  pid: number;
  sessionId: string;
  cwd: string;
  paneId: string;
};

export type ClaudePaneProcess = {
  paneId: string;
  panePid?: number;
};

// Claude Code writes <config>/sessions/<pid>.json with its session id and tmux location ("fleet:@11.%12").
export function parseClaudeSessionFile(serialized: string): ClaudeSessionFile | null {
  try {
    const value = JSON.parse(serialized) as Record<string, unknown>;
    const paneId = typeof value.tmux === "string" ? value.tmux.match(/(%\d+)$/)?.[1] : undefined;
    if (typeof value.pid !== "number" || typeof value.sessionId !== "string" || typeof value.cwd !== "string" || !paneId) {
      return null;
    }
    return { pid: value.pid, sessionId: value.sessionId, cwd: value.cwd, paneId };
  } catch {
    return null;
  }
}

// Mirrors Claude Code's project directory naming: every non-alphanumeric character becomes "-".
export function claudeProjectDirName(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

// Newest owner-typed prompt in a transcript tail; peers, tool results and meta records are ignored.
export function lastHumanPromptAtMs(transcriptTail: string): number | undefined {
  const lines = transcriptTail.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (!line.includes("\"human\"")) {
      continue;
    }
    try {
      const record = JSON.parse(line) as { type?: unknown; timestamp?: unknown; origin?: { kind?: unknown } };
      const atMs = typeof record.timestamp === "string" ? Date.parse(record.timestamp) : NaN;
      if (record.type === "user" && record.origin?.kind === "human" && Number.isFinite(atMs)) {
        return atMs;
      }
    } catch {
      // The first line of a tail is usually cut mid-record.
    }
  }
  return undefined;
}

export function parseProcessParents(psOutput: string): Map<number, number> {
  const parents = new Map<number, number>();
  for (const line of psOutput.split("\n")) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (Number.isInteger(pid) && Number.isInteger(ppid)) {
      parents.set(pid, ppid);
    }
  }
  return parents;
}

// Pane ids are reused after a tmux restart, so trust a session file only while its live process is the pane's.
export function isLiveClaudePane(session: ClaudeSessionFile, pane: ClaudePaneProcess | undefined, parents: Map<number, number>): boolean {
  if (!pane?.panePid || !parents.has(session.pid)) {
    return false;
  }
  return session.pid === pane.panePid || parents.get(session.pid) === pane.panePid;
}

async function readTail(filePath: string, bytes: number): Promise<string> {
  const handle = await open(filePath, "r");
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, bytes);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    return buffer.toString("utf8");
  } finally {
    await handle.close();
  }
}

// Read-only, cached view of the owner's last Claude prompt per tmux pane. Never blocks the caller.
export class ClaudePromptTimes {
  private latest = new Map<string, number>();
  private refreshedAtMs = 0;
  private refreshing: Promise<void> | null = null;
  private readonly transcriptCache = new Map<string, { size: number; mtimeMs: number; atMs: number | undefined }>();

  constructor(private readonly configDir: string = DEFAULT_CLAUDE_CONFIG_DIR) {}

  get(panes: ClaudePaneProcess[]): Map<string, number> {
    if (!this.refreshing && Date.now() - this.refreshedAtMs >= REFRESH_INTERVAL_MS) {
      const refresh = this.refresh(panes);
      const timeout = new Promise<void>((resolve) => setTimeout(resolve, REFRESH_TIMEOUT_MS).unref());
      this.refreshing = Promise.race([refresh, timeout])
        .catch(() => undefined)
        .finally(() => {
          this.refreshedAtMs = Date.now();
          this.refreshing = null;
        });
    }
    return this.latest;
  }

  async refresh(panes: ClaudePaneProcess[]): Promise<void> {
    const sessionsDir = path.join(this.configDir, "sessions");
    const names = (await readdir(sessionsDir).catch(() => [] as string[])).filter((name) => /^\d+\.json$/.test(name));
    if (names.length === 0) {
      this.latest = new Map();
      return;
    }
    const parents = parseProcessParents((await execFileAsync("ps", ["-A", "-o", "pid=,ppid="])).stdout);
    const panesById = new Map(panes.map((pane) => [pane.paneId, pane]));
    const next = new Map<string, number>();
    const visited = new Set<string>();
    for (const name of names) {
      const session = parseClaudeSessionFile(await readFile(path.join(sessionsDir, name), "utf8").catch(() => ""));
      if (!session || !isLiveClaudePane(session, panesById.get(session.paneId), parents)) {
        continue;
      }
      const transcriptPath = path.join(this.configDir, "projects", claudeProjectDirName(session.cwd), `${session.sessionId}.jsonl`);
      visited.add(transcriptPath);
      const atMs = await this.readPromptAtMs(transcriptPath);
      if (atMs) {
        next.set(session.paneId, Math.max(next.get(session.paneId) ?? 0, atMs));
      }
    }
    this.latest = next;
    for (const transcriptPath of this.transcriptCache.keys()) {
      if (!visited.has(transcriptPath)) {
        this.transcriptCache.delete(transcriptPath);
      }
    }
  }

  private async readPromptAtMs(transcriptPath: string): Promise<number | undefined> {
    const info = await stat(transcriptPath).catch(() => null);
    if (!info) {
      return undefined;
    }
    const cached = this.transcriptCache.get(transcriptPath);
    if (cached && cached.size === info.size && cached.mtimeMs === info.mtimeMs) {
      return cached.atMs;
    }
    const tail = await readTail(transcriptPath, TRANSCRIPT_TAIL_BYTES);
    // A long tool-heavy turn can push the prompt out of the tail; keep the last one seen.
    const atMs = lastHumanPromptAtMs(tail) ?? cached?.atMs;
    this.transcriptCache.set(transcriptPath, { size: info.size, mtimeMs: info.mtimeMs, atMs });
    return atMs;
  }
}
