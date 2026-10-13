import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { TmuxSessionStatusDto, TmuxSessionStatusKind } from "../shared/api.js";
import { TMUX_STATUS_TITLES } from "../shared/tmuxStatus.js";

// ~/.gp/tools/agent-status is the one classifier gpmon, tmux and `b agents` read; atw's dots must match it.
export const DEFAULT_AGENT_STATUS_SNAPSHOT = process.env.AGENT_STATUS_SNAPSHOT
  || path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"), "agent-status", "snapshot.json");
export const DEFAULT_AGENT_STATUS_BIN = process.env.ATW_AGENT_STATUS_BIN
  ?? path.join(os.homedir(), ".gp", "tools", "agent-status", "agent-status");
// Older than this means agent-status stopped refreshing; atw falls back to its own heuristics.
export const AGENT_ROWS_STALE_AFTER_MS = 30_000;
// agent-status's freshness target: older than this, ask it to refresh.
export const AGENT_STATUS_KICK_AFTER_MS = 3000;
export const AGENT_STATUS_KICK_ARGS = ["refresh", "--max-age", "2", "--format", "none"] as const;
const KICK_MIN_INTERVAL_MS = 2000;
const REREAD_INTERVAL_MS = 2000;
const READ_TIMEOUT_MS = 500;
const SCHEMA_VERSION = 1;

const AGENT_ROW_STATES: ReadonlySet<string> = new Set<TmuxSessionStatusKind>(["working", "blocked", "done", "idle", "unknown"]);

export type AgentRow = {
  paneId: string;
  kind: string;
  status: TmuxSessionStatusKind;
  rule?: string;
  idleSinceSec?: number;
};

export type AgentRowsSnapshot = {
  epochSec: number;
  rows: Map<string, AgentRow>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// agent-status's snapshot.json: {schema_version: 1, generated_at: RFC3339, rows: [{pane_id, kind, state, rule, idle_since, ...}]}.
export function parseAgentStatusSnapshot(serialized: string): AgentRowsSnapshot | null {
  let document: unknown;
  try {
    document = JSON.parse(serialized);
  } catch {
    return null;
  }
  if (!isRecord(document) || document.schema_version !== SCHEMA_VERSION || typeof document.generated_at !== "string" || !Array.isArray(document.rows)) {
    return null;
  }
  const generatedMs = Date.parse(document.generated_at);
  if (!Number.isFinite(generatedMs)) {
    return null;
  }
  const rows = new Map<string, AgentRow>();
  for (const row of document.rows) {
    if (!isRecord(row)) {
      continue;
    }
    const { pane_id: paneId, kind, state, rule, idle_since: idleSince } = row;
    // Grouped tmux sessions list one pane under several sessions; its state is per pane, so the first row is enough.
    if (typeof paneId !== "string" || !/^%\d+$/.test(paneId) || rows.has(paneId) || typeof kind !== "string" || !kind) {
      continue;
    }
    rows.set(paneId, {
      paneId,
      kind,
      // gpmon projects any state it does not know as unknown.
      status: typeof state === "string" && AGENT_ROW_STATES.has(state) ? state as TmuxSessionStatusKind : "unknown",
      ...(typeof rule === "string" && rule ? { rule } : {}),
      ...(typeof idleSince === "number" && Number.isSafeInteger(idleSince) && idleSince >= 0 ? { idleSinceSec: idleSince } : {})
    });
  }
  return { epochSec: Math.floor(generatedMs / 1000), rows };
}

function snapshotAgeMs(snapshot: AgentRowsSnapshot | null, nowMs: number): number {
  return snapshot ? nowMs - snapshot.epochSec * 1000 : Number.POSITIVE_INFINITY;
}

// The snapshot, or null when it is missing, from the future or stale.
export function freshAgentRows(snapshot: AgentRowsSnapshot | null, nowMs: number): AgentRowsSnapshot | null {
  const nowSec = Math.floor(nowMs / 1000);
  if (!snapshot || snapshot.epochSec > nowSec || (nowSec - snapshot.epochSec) * 1000 > AGENT_ROWS_STALE_AFTER_MS) {
    return null;
  }
  return snapshot;
}

// Statuses by pane id, or none at all when the snapshot is missing, from the future or stale.
export function agentRowStatuses(snapshot: AgentRowsSnapshot | null, nowMs: number): Map<string, TmuxSessionStatusDto> {
  const fresh = freshAgentRows(snapshot, nowMs);
  if (!fresh) {
    return new Map();
  }
  const nowSec = Math.floor(nowMs / 1000);
  return new Map([...fresh.rows].map(([paneId, row]) => [paneId, agentRowStatus(row, nowSec)]));
}

export function agentRowStatus(row: AgentRow, nowSec: number): TmuxSessionStatusDto {
  // Idle and done both show how long the agent has been quiet, as gpmon does.
  const quietFor = (row.status === "idle" || row.status === "done") && row.idleSinceSec !== undefined && row.idleSinceSec <= nowSec
    ? ` ${compactAge(nowSec - row.idleSinceSec)}`
    : "";
  return { kind: row.status, title: `${TMUX_STATUS_TITLES[row.status]}${quietFor}`, source: "gpmon" };
}

// Same rounding as gpmon's compact_age.
function compactAge(seconds: number): string {
  return seconds < 3600 ? `${Math.floor(seconds / 60)}m` : `${Math.floor(seconds / 3600)}h`;
}

export type AgentStatusKicker = () => void;

// Fire-and-forget `agent-status refresh --max-age 2`; its lock makes concurrent kicks share one scan.
export function spawnAgentStatusRefresh(binary: string): AgentStatusKicker {
  return () => {
    if (!binary) {
      return;
    }
    try {
      accessSync(binary, constants.X_OK);
      const child = spawn(binary, [...AGENT_STATUS_KICK_ARGS], { detached: true, stdio: "ignore" });
      child.on("error", () => undefined);
      child.unref();
    } catch {
      // No agent-status on this host: the heuristics fallback covers it.
    }
  };
}

// Read-only view of agent-status's snapshot, re-read at most every two seconds; asks for a refresh when it ages.
export class AgentRowsCache {
  private snapshot: AgentRowsSnapshot | null = null;
  private readAtMs = Number.NEGATIVE_INFINITY;
  private kickedAtMs = Number.NEGATIVE_INFINITY;
  private reading: Promise<void> | null = null;

  constructor(
    private readonly filePath: string = DEFAULT_AGENT_STATUS_SNAPSHOT,
    private readonly now: () => number = Date.now,
    private readonly kick: AgentStatusKicker = spawnAgentStatusRefresh(DEFAULT_AGENT_STATUS_BIN)
  ) {}

  async statuses(): Promise<Map<string, TmuxSessionStatusDto>> {
    await this.reread();
    return agentRowStatuses(this.snapshot, this.now());
  }

  // Rows with their kind, state and idle_since, or null while agent-status is not refreshing.
  async rows(): Promise<AgentRowsSnapshot | null> {
    await this.reread();
    return freshAgentRows(this.snapshot, this.now());
  }

  private async reread(): Promise<void> {
    if (this.now() - this.readAtMs >= REREAD_INTERVAL_MS) {
      this.reading ??= this.read().finally(() => {
        this.reading = null;
      });
      await this.reading;
    }
  }

  private maybeKick(): void {
    const nowMs = this.now();
    if (snapshotAgeMs(this.snapshot, nowMs) < AGENT_STATUS_KICK_AFTER_MS || nowMs - this.kickedAtMs < KICK_MIN_INTERVAL_MS) {
      return;
    }
    this.kickedAtMs = nowMs;
    this.kick();
  }

  private async read(): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), READ_TIMEOUT_MS);
      timer.unref();
    });
    try {
      const serialized = await Promise.race([readFile(this.filePath, "utf8"), timeout]);
      this.snapshot = serialized === null ? null : parseAgentStatusSnapshot(serialized);
    } catch {
      this.snapshot = null;
    } finally {
      clearTimeout(timer);
      this.readAtMs = this.now();
      this.maybeKick();
    }
  }
}
