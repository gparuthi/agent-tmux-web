import { describe, expect, it } from "vitest";

import type { TmuxSessionDto } from "../../shared/api.js";
import { filterZenPanes, isZenActivePane, nextZenPane, parseZenMode, serializeZenMode, ZEN_ACTIVE_WITHIN_MS, ZEN_MODE_STORAGE_KEY } from "../zenMode.js";

const NOW = Date.parse("2026-10-22T12:00:00Z");

const pane = (name: string, extra: Partial<TmuxSessionDto> = {}): TmuxSessionDto => ({
  name,
  session: "main",
  windows: 1,
  created: "2026-10-01T00:00:00.000Z",
  attached: false,
  ...extra
});

const recent = (name: string, extra: Partial<TmuxSessionDto> = {}) => pane(name, { lastInputAtMs: NOW - 60_000, ...extra });
const old = (name: string, extra: Partial<TmuxSessionDto> = {}) => pane(name, { lastInputAtMs: NOW - ZEN_ACTIVE_WITHIN_MS - 1, ...extra });

describe("isZenActivePane", () => {
  it("keeps a pane prompted within 24h, edge included, and drops one just past it", () => {
    expect(isZenActivePane(pane("%1", { lastInputAtMs: NOW - ZEN_ACTIVE_WITHIN_MS }), NOW)).toBe(true);
    expect(isZenActivePane(pane("%1", { lastInputAtMs: NOW - ZEN_ACTIVE_WITHIN_MS - 1 }), NOW)).toBe(false);
  });

  it("drops a pane the owner never prompted", () => {
    expect(isZenActivePane(pane("%1"), NOW)).toBe(false);
  });

  it("keeps an old pane while its agent is working", () => {
    expect(isZenActivePane(old("%1", { status: { kind: "working", title: "Working" } }), NOW)).toBe(true);
    expect(isZenActivePane(old("%1", { status: { kind: "idle", title: "Idle 3d" } }), NOW)).toBe(false);
  });

  it("drops a snoozed pane even when recent or working", () => {
    expect(isZenActivePane(recent("%1", { snoozedUntilMs: NOW + 1000 }), NOW)).toBe(false);
    expect(isZenActivePane(old("%1", { snoozedUntilMs: NOW + 1000, status: { kind: "working", title: "Working" } }), NOW)).toBe(false);
  });
});

describe("filterZenPanes", () => {
  const panes = [recent("%1"), old("%2"), old("%3", { status: { kind: "working", title: "Working" } })];

  it("hides inactive panes", () => {
    expect(filterZenPanes(panes, "%1", NOW).map((entry) => entry.name)).toEqual(["%1", "%3"]);
  });

  it("always keeps the selected pane even when inactive", () => {
    expect(filterZenPanes(panes, "%2", NOW).map((entry) => entry.name)).toEqual(["%1", "%2", "%3"]);
  });
});

describe("nextZenPane", () => {
  // Same session groups sort by newest input, so give each a distinct recency.
  const inRail = (name: string, ageMs: number, extra: Partial<TmuxSessionDto> = {}) => pane(name, { lastInputAtMs: NOW - ageMs, ...extra });

  it("walks active panes in rail order and wraps", () => {
    const panes = [inRail("%1", 1000), inRail("%2", 2000), inRail("%3", 3000)];
    expect(nextZenPane(panes, [], "%1", NOW)).toBe("%2");
    expect(nextZenPane(panes, [], "%2", NOW)).toBe("%3");
    expect(nextZenPane(panes, [], "%3", NOW)).toBe("%1");
  });

  it("skips inactive and snoozed panes", () => {
    const panes = [inRail("%1", 1000), inRail("%2", 2000, { snoozedUntilMs: NOW + 5000 }), inRail("%3", ZEN_ACTIVE_WITHIN_MS + 10), inRail("%4", 4000)];
    expect(nextZenPane(panes, [], "%1", NOW)).toBe("%4");
  });

  it("follows pinned panes first, then session groups", () => {
    const panes = [inRail("%1", 1000), inRail("%2", 2000, { session: "other" }), inRail("%3", 3000, { session: "other" })];
    expect(nextZenPane(panes, ["%3"], "%3", NOW)).toBe("%1");
    expect(nextZenPane(panes, ["%3"], "%1", NOW)).toBe("%2");
  });

  it("moves on from an inactive selected pane to the next active one after it", () => {
    const panes = [inRail("%1", 1000), inRail("%2", ZEN_ACTIVE_WITHIN_MS + 10), inRail("%3", ZEN_ACTIVE_WITHIN_MS + 20, { status: { kind: "working", title: "Working" } })];
    expect(nextZenPane(panes, [], "%2", NOW)).toBe("%3");
  });

  it("returns nothing when only the current pane is active", () => {
    expect(nextZenPane([inRail("%1", 1000), inRail("%2", ZEN_ACTIVE_WITHIN_MS + 10)], [], "%1", NOW)).toBe("");
    expect(nextZenPane([], [], "%1", NOW)).toBe("");
  });

  it("starts from the first active pane when the selection is gone", () => {
    expect(nextZenPane([inRail("%1", 1000), inRail("%2", 2000)], [], "%9", NOW)).toBe("%1");
  });
});

describe("zen mode persistence", () => {
  it("round-trips through the stored string", () => {
    expect(ZEN_MODE_STORAGE_KEY).toBe("agent-tmux-web.zen-mode");
    expect(parseZenMode(serializeZenMode(true))).toBe(true);
    expect(parseZenMode(serializeZenMode(false))).toBe(false);
  });

  it("defaults to off for missing or unknown values", () => {
    expect(parseZenMode(null)).toBe(false);
    expect(parseZenMode("")).toBe(false);
    expect(parseZenMode("yes")).toBe(false);
  });
});
