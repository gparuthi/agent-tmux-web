import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AgentRowsCache, agentRowStatuses, parseAgentRowsCache } from "../agentRows.js";

const NOW_SEC = 1_791_144_148;
const NOW_MS = NOW_SEC * 1000;

// Shape of ~/.local/state/claude-tmux-resume/agent-rows.cache: epoch line, then 6 to 9 pipe fields per row.
function cacheText(epochSec: number, rows: string[]): string {
  return `${[String(epochSec), ...rows].join("\n")}\n`;
}

const ROWS = [
  "_hidden|0|✳ Camera eval|%8|claude|idle||1791134142|/Users/me/work/playground",
  "gp|1|build|%27|codex|working|11||/Users/me/.gp",
  "gp|2|review|%30|claude|blocked|40||/Users/me/.gp",
  "gp|3|ship|%31|codex|done|||/Users/me/.gp",
  "gp|4|odd|%4|claude|unknown||",
  "legacy|0|six-field|%40|opencode|idle",
  "gp|5|future|%41|claude|confused|||",
  "this line is malformed",
  "gp|6||%42|claude|working|||",
  "gp|7|not-a-pane|@3|claude|working|||",
  "grouped|0|✳ Camera eval|%8|claude|working||1791134142|"
];

describe("gpmon agent-rows cache", () => {
  it("parses rows by pane id and skips malformed lines", () => {
    const snapshot = parseAgentRowsCache(cacheText(NOW_SEC - 5, ROWS));

    expect(snapshot?.epochSec).toBe(NOW_SEC - 5);
    expect([...(snapshot?.rows.keys() ?? [])]).toEqual(["%8", "%27", "%30", "%31", "%4", "%40", "%41"]);
    expect(snapshot?.rows.get("%8")).toEqual({ paneId: "%8", kind: "claude", status: "idle", idleSinceSec: 1791134142 });
    expect(snapshot?.rows.get("%27")).toEqual({ paneId: "%27", kind: "codex", status: "working" });
    expect(snapshot?.rows.get("%40")).toEqual({ paneId: "%40", kind: "opencode", status: "idle" });
    // Like gpmon, statuses it does not know read as unknown.
    expect(snapshot?.rows.get("%41")?.status).toBe("unknown");
    // A grouped session repeats a pane; the first row wins.
    expect(snapshot?.rows.get("%8")?.status).toBe("idle");
  });

  it("rejects a cache without an epoch stamp", () => {
    expect(parseAgentRowsCache("")).toBeNull();
    expect(parseAgentRowsCache("not-a-stamp\ngp|1|build|%27|codex|working\n")).toBeNull();
    expect(parseAgentRowsCache("gp|1|build|%27|codex|working\n")).toBeNull();
  });

  it("maps fresh rows to statuses with gpmon's idle age", () => {
    const statuses = agentRowStatuses(parseAgentRowsCache(cacheText(NOW_SEC - 5, ROWS)), NOW_MS);

    expect(statuses.get("%8")).toEqual({ kind: "idle", title: "Idle 2h", source: "gpmon" });
    expect(statuses.get("%27")).toEqual({ kind: "working", title: "Working", source: "gpmon" });
    expect(statuses.get("%30")).toEqual({ kind: "blocked", title: "Blocked", source: "gpmon" });
    expect(statuses.get("%31")).toEqual({ kind: "done", title: "Done", source: "gpmon" });
    expect(statuses.get("%4")).toEqual({ kind: "unknown", title: "Unknown", source: "gpmon" });
    expect(statuses.get("%40")).toEqual({ kind: "idle", title: "Idle", source: "gpmon" });
    expect(statuses.has("%99")).toBe(false);

    const recent = agentRowStatuses(parseAgentRowsCache(cacheText(NOW_SEC, [`gp|0|w|%1|claude|idle||${NOW_SEC - 750}|`])), NOW_MS);
    expect(recent.get("%1")?.title).toBe("Idle 12m");
  });

  it("drops the whole cache once it is older than gpmon's 30s stale_after_ms, or from the future", () => {
    expect(agentRowStatuses(parseAgentRowsCache(cacheText(NOW_SEC - 30, ROWS)), NOW_MS).size).toBe(7);
    expect(agentRowStatuses(parseAgentRowsCache(cacheText(NOW_SEC - 31, ROWS)), NOW_MS).size).toBe(0);
    expect(agentRowStatuses(parseAgentRowsCache(cacheText(NOW_SEC + 60, ROWS)), NOW_MS).size).toBe(0);
    expect(agentRowStatuses(null, NOW_MS).size).toBe(0);
  });

  describe("reader", () => {
    let dir = "";
    let cachePath = "";
    let nowMs = NOW_MS;

    beforeEach(async () => {
      dir = await mkdtemp(path.join(tmpdir(), "atw-agent-rows-"));
      cachePath = path.join(dir, "agent-rows.cache");
      nowMs = NOW_MS;
    });

    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it("reads the file, re-reads after two seconds and falls back to nothing when it is missing", async () => {
      const cache = new AgentRowsCache(cachePath, () => nowMs);
      expect((await cache.statuses()).size).toBe(0);

      await writeFile(cachePath, cacheText(NOW_SEC, ["gp|1|build|%27|codex|working|||"]));
      nowMs += 1000;
      expect((await cache.statuses()).size).toBe(0);
      nowMs += 1000;
      expect((await cache.statuses()).get("%27")?.kind).toBe("working");

      await writeFile(cachePath, cacheText(NOW_SEC + 2, ["gp|1|build|%27|codex|done|||"]));
      nowMs += 500;
      expect((await cache.statuses()).get("%27")?.kind).toBe("working");
      nowMs += 1500;
      expect((await cache.statuses()).get("%27")?.kind).toBe("done");

      // Staleness is judged at lookup time, so a cache that stops refreshing ages out.
      nowMs += 40_000;
      expect((await cache.statuses()).size).toBe(0);
    });
  });
});
