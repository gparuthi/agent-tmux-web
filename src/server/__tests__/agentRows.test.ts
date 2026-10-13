import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AGENT_STATUS_KICK_ARGS, AgentRowsCache, agentRowStatuses, parseAgentStatusSnapshot } from "../agentRows.js";

const NOW_SEC = 1_791_144_148;
const NOW_MS = NOW_SEC * 1000;

type Row = Record<string, unknown>;

function row(paneId: unknown, kind: unknown, state: unknown, extra: Row = {}): Row {
  return { pane_id: paneId, target: "gp:1", kind, state, rule: null, session: "gp", window: "1", window_name: "w", tty: "/dev/ttys001", cwd: "/w", command: "node", ctx_pct: null, idle_since: null, ...extra };
}

// Shape of ~/.local/state/agent-status/snapshot.json, written by ~/.gp/tools/agent-status.
function snapshotText(epochSec: number, rows: unknown[], schemaVersion: unknown = 1): string {
  return JSON.stringify({ schema_version: schemaVersion, generated_at: new Date(epochSec * 1000).toISOString(), rows });
}

const ROWS = [
  row("%8", "claude", "idle", { idle_since: 1791134142, rule: "live_prompt_box" }),
  row("%27", "codex", "working", { rule: "status_row_working", ctx_pct: 68 }),
  row("%30", "claude", "blocked", { rule: "generic_permission_prompt" }),
  row("%31", "codex", "done", { rule: "turn_complete", idle_since: NOW_SEC - 750 }),
  row("%4", "claude", "unknown", { rule: "transcript_viewer" }),
  row("%40", "pi", "idle"),
  row("%41", "claude", "confused"),
  "this row is malformed",
  row("%42", "", "working"),
  row("@3", "claude", "working"),
  row("%43", "claude", "idle", { idle_since: -5 }),
  row("%8", "claude", "working", { session: "grouped" })
];

describe("agent-status snapshot", () => {
  it("parses rows by pane id and skips malformed ones", () => {
    const snapshot = parseAgentStatusSnapshot(snapshotText(NOW_SEC - 5, ROWS));

    expect(snapshot?.epochSec).toBe(NOW_SEC - 5);
    expect([...(snapshot?.rows.keys() ?? [])]).toEqual(["%8", "%27", "%30", "%31", "%4", "%40", "%41", "%43"]);
    expect(snapshot?.rows.get("%8")).toEqual({ paneId: "%8", kind: "claude", status: "idle", rule: "live_prompt_box", idleSinceSec: 1791134142 });
    expect(snapshot?.rows.get("%27")).toEqual({ paneId: "%27", kind: "codex", status: "working", rule: "status_row_working" });
    expect(snapshot?.rows.get("%40")).toEqual({ paneId: "%40", kind: "pi", status: "idle" });
    // Like gpmon, states it does not know read as unknown.
    expect(snapshot?.rows.get("%41")?.status).toBe("unknown");
    // A negative idle_since is not a time.
    expect(snapshot?.rows.get("%43")?.idleSinceSec).toBeUndefined();
    // A grouped session repeats a pane; the first row wins.
    expect(snapshot?.rows.get("%8")?.status).toBe("idle");
  });

  it("rejects anything but a schema 1 snapshot with a timestamp", () => {
    expect(parseAgentStatusSnapshot("")).toBeNull();
    expect(parseAgentStatusSnapshot("not json")).toBeNull();
    expect(parseAgentStatusSnapshot("[]")).toBeNull();
    expect(parseAgentStatusSnapshot(snapshotText(NOW_SEC, ROWS, 2))).toBeNull();
    expect(parseAgentStatusSnapshot(JSON.stringify({ schema_version: 1, generated_at: "soon", rows: [] }))).toBeNull();
    expect(parseAgentStatusSnapshot(JSON.stringify({ schema_version: 1, generated_at: "2026-10-04T20:25:02Z" }))).toBeNull();
    // The legacy pipe cache is not a snapshot.
    expect(parseAgentStatusSnapshot("1791144148\ngp|1|build|%27|codex|working\n")).toBeNull();
  });

  it("maps fresh rows to statuses with gpmon's quiet age for idle and done", () => {
    const statuses = agentRowStatuses(parseAgentStatusSnapshot(snapshotText(NOW_SEC - 5, ROWS)), NOW_MS);

    expect(statuses.get("%8")).toEqual({ kind: "idle", title: "Idle 2h", source: "gpmon" });
    expect(statuses.get("%27")).toEqual({ kind: "working", title: "Working", source: "gpmon" });
    expect(statuses.get("%30")).toEqual({ kind: "blocked", title: "Blocked", source: "gpmon" });
    expect(statuses.get("%31")).toEqual({ kind: "done", title: "Done 12m", source: "gpmon" });
    expect(statuses.get("%4")).toEqual({ kind: "unknown", title: "Unknown", source: "gpmon" });
    expect(statuses.get("%40")).toEqual({ kind: "idle", title: "Idle", source: "gpmon" });
    expect(statuses.has("%99")).toBe(false);
  });

  it("drops the whole snapshot once it is older than 30s, or from the future", () => {
    expect(agentRowStatuses(parseAgentStatusSnapshot(snapshotText(NOW_SEC - 30, ROWS)), NOW_MS).size).toBe(8);
    expect(agentRowStatuses(parseAgentStatusSnapshot(snapshotText(NOW_SEC - 31, ROWS)), NOW_MS).size).toBe(0);
    expect(agentRowStatuses(parseAgentStatusSnapshot(snapshotText(NOW_SEC + 60, ROWS)), NOW_MS).size).toBe(0);
    expect(agentRowStatuses(null, NOW_MS).size).toBe(0);
  });

  it("asks agent-status for a bounded-age refresh", () => {
    expect([...AGENT_STATUS_KICK_ARGS]).toEqual(["refresh", "--max-age", "2", "--format", "none"]);
  });

  describe("reader", () => {
    let dir = "";
    let snapshotPath = "";
    let nowMs = NOW_MS;
    let kicks = 0;

    beforeEach(async () => {
      dir = await mkdtemp(path.join(tmpdir(), "atw-agent-status-"));
      snapshotPath = path.join(dir, "snapshot.json");
      nowMs = NOW_MS;
      kicks = 0;
    });

    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    function reader(): AgentRowsCache {
      return new AgentRowsCache(snapshotPath, () => nowMs, () => {
        kicks += 1;
      });
    }

    it("reads the file, re-reads after two seconds and falls back to nothing when it is missing", async () => {
      const cache = reader();
      expect((await cache.statuses()).size).toBe(0);

      await writeFile(snapshotPath, snapshotText(NOW_SEC, [row("%27", "codex", "working")]));
      nowMs += 1000;
      expect((await cache.statuses()).size).toBe(0);
      nowMs += 1000;
      expect((await cache.statuses()).get("%27")?.kind).toBe("working");

      await writeFile(snapshotPath, snapshotText(NOW_SEC + 2, [row("%27", "codex", "done")]));
      nowMs += 500;
      expect((await cache.statuses()).get("%27")?.kind).toBe("working");
      nowMs += 1500;
      expect((await cache.statuses()).get("%27")?.kind).toBe("done");

      // Staleness is judged at lookup time, so a snapshot that stops refreshing ages out.
      nowMs += 40_000;
      expect((await cache.statuses()).size).toBe(0);
    });

    it("serves the fresh rows with kind and idle_since for the send queue, and null once stale", async () => {
      const cache = reader();
      expect(await cache.rows()).toBeNull();

      await writeFile(snapshotPath, snapshotText(NOW_SEC, [row("%9", "hax", "done", { idle_since: NOW_SEC - 4 })]));
      nowMs += 2000;
      const snapshot = await cache.rows();
      expect(snapshot?.epochSec).toBe(NOW_SEC);
      expect(snapshot?.rows.get("%9")).toEqual({ paneId: "%9", kind: "hax", status: "done", idleSinceSec: NOW_SEC - 4 });

      nowMs += 40_000;
      expect(await cache.rows()).toBeNull();
    });

    it("kicks a refresh when the snapshot is missing or 3s old, at most every 2s", async () => {
      const cache = reader();
      await cache.statuses();
      expect(kicks).toBe(1);

      await writeFile(snapshotPath, snapshotText(NOW_SEC, [row("%27", "codex", "working")]));
      nowMs += 2000;
      await cache.statuses();
      // Fresh (2s old): no kick.
      expect(kicks).toBe(1);

      nowMs += 2000;
      await cache.statuses();
      expect(kicks).toBe(2);

      // Within the 2s re-read window nothing is re-read or kicked.
      nowMs += 1000;
      await cache.statuses();
      expect(kicks).toBe(2);
    });
  });
});
