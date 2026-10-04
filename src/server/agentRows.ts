import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { TmuxSessionStatusDto, TmuxSessionStatusKind } from "../shared/api.js";
import { TMUX_STATUS_TITLES } from "../shared/tmuxStatus.js";

// gpmon's agents panel reads the same file; the owner wants atw's dots to match it exactly.
export const DEFAULT_AGENT_ROWS_CACHE = process.env.AGENT_ROWS_CACHE
  || path.join(os.homedir(), ".local", "state", "claude-tmux-resume", "agent-rows.cache");
// gpmon's agents plugin mutes rows past stale_after_ms 30000; atw falls back to its own heuristics instead.
export const AGENT_ROWS_STALE_AFTER_MS = 30_000;
const REREAD_INTERVAL_MS = 2000;
const READ_TIMEOUT_MS = 500;

const AGENT_ROW_STATES: ReadonlySet<string> = new Set<TmuxSessionStatusKind>(["working", "blocked", "done", "idle", "unknown"]);

export type AgentRow = {
  paneId: string;
  kind: string;
  status: TmuxSessionStatusKind;
  idleSinceSec?: number;
};

export type AgentRowsSnapshot = {
  epochSec: number;
  rows: Map<string, AgentRow>;
};

// Written by ~/.gp/tools/claude-tmux-resume/lib-agent-status.sh: line 1 is the write epoch, then
// "session|window|window_name|pane_id|kind|status|ctx|idle_since|cwd" with the first six required.
export function parseAgentRowsCache(serialized: string): AgentRowsSnapshot | null {
  const [stamp = "", ...lines] = serialized.split("\n");
  if (!/^\d+$/.test(stamp.trim())) {
    return null;
  }
  const rows = new Map<string, AgentRow>();
  for (const line of lines) {
    const fields = line.split("|");
    if (fields.length < 6 || fields.slice(0, 6).some((field) => !field)) {
      continue;
    }
    const [, , , paneId, kind, status, , idleSince = ""] = fields;
    // Grouped tmux sessions list one pane under several sessions; its status is per pane, so the first row is enough.
    if (!/^%\d+$/.test(paneId) || rows.has(paneId)) {
      continue;
    }
    rows.set(paneId, {
      paneId,
      kind,
      // gpmon projects any status it does not know as unknown.
      status: AGENT_ROW_STATES.has(status) ? status as TmuxSessionStatusKind : "unknown",
      ...(/^\d+$/.test(idleSince) ? { idleSinceSec: Number(idleSince) } : {})
    });
  }
  return { epochSec: Number(stamp.trim()), rows };
}

// Statuses by pane id, or none at all when the cache is missing, from the future or stale.
export function agentRowStatuses(snapshot: AgentRowsSnapshot | null, nowMs: number): Map<string, TmuxSessionStatusDto> {
  const nowSec = Math.floor(nowMs / 1000);
  if (!snapshot || snapshot.epochSec > nowSec || (nowSec - snapshot.epochSec) * 1000 > AGENT_ROWS_STALE_AFTER_MS) {
    return new Map();
  }
  return new Map([...snapshot.rows].map(([paneId, row]) => [paneId, agentRowStatus(row, nowSec)]));
}

export function agentRowStatus(row: AgentRow, nowSec: number): TmuxSessionStatusDto {
  const idleFor = row.status === "idle" && row.idleSinceSec !== undefined && row.idleSinceSec <= nowSec
    ? ` ${compactAge(nowSec - row.idleSinceSec)}`
    : "";
  return { kind: row.status, title: `${TMUX_STATUS_TITLES[row.status]}${idleFor}`, source: "gpmon" };
}

// Same rounding as gpmon's compact_age.
function compactAge(seconds: number): string {
  return seconds < 3600 ? `${Math.floor(seconds / 60)}m` : `${Math.floor(seconds / 3600)}h`;
}

// Read-only view of gpmon's agent-rows cache, re-read at most every two seconds.
export class AgentRowsCache {
  private snapshot: AgentRowsSnapshot | null = null;
  private readAtMs = Number.NEGATIVE_INFINITY;
  private reading: Promise<void> | null = null;

  constructor(
    private readonly filePath: string = DEFAULT_AGENT_ROWS_CACHE,
    private readonly now: () => number = Date.now
  ) {}

  async statuses(): Promise<Map<string, TmuxSessionStatusDto>> {
    if (this.now() - this.readAtMs >= REREAD_INTERVAL_MS) {
      this.reading ??= this.read().finally(() => {
        this.reading = null;
      });
      await this.reading;
    }
    return agentRowStatuses(this.snapshot, this.now());
  }

  private async read(): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), READ_TIMEOUT_MS);
      timer.unref();
    });
    try {
      const serialized = await Promise.race([readFile(this.filePath, "utf8"), timeout]);
      this.snapshot = serialized === null ? null : parseAgentRowsCache(serialized);
    } catch {
      this.snapshot = null;
    } finally {
      clearTimeout(timer);
      this.readAtMs = this.now();
    }
  }
}
