import { describe, expect, it } from "vitest";

import type { TmuxSessionDto, TmuxSessionStatusDto } from "../../shared/api.js";
import {
  aggregateTmuxSessionStatus,
  defaultTmuxSessionGroupCollapsed,
  filterTmuxAgentPanes,
  groupTmuxPanes,
  hasUnseenTmuxActivity,
  initialTmuxPaneSelection,
  isTmuxSessionGroupCollapsed,
  markTmuxPanesViewed,
  MAX_STORED_TMUX_PANE_VIEWS,
  nextTmuxRailPaneAfter,
  MAX_STORED_TMUX_SESSION_GROUPS,
  parseTmuxPaneViews,
  parseTmuxSessionGroupPreferences,
  setTmuxSessionGroupCollapsed,
  tmuxPaneGroupDetail,
  tmuxPaneStatus,
  tmuxWindowPaneNames,
  visibleTmuxRailPanes
} from "../tmuxSessionGroups.js";

const WORKING: TmuxSessionStatusDto = { kind: "working", title: "Working" };
const QUESTION: TmuxSessionStatusDto = { kind: "blocked", title: "Asking a question" };
const PERMISSION: TmuxSessionStatusDto = { kind: "blocked", title: "Needs permission" };
const DONE: TmuxSessionStatusDto = { kind: "done", title: "Done" };
const IDLE: TmuxSessionStatusDto = { kind: "idle", title: "Idle 12m" };
const UNKNOWN: TmuxSessionStatusDto = { kind: "unknown", title: "Unknown" };

const pane = (name: string, session: string | undefined, extra: Partial<TmuxSessionDto> = {}): TmuxSessionDto => ({
  name,
  session,
  windows: 1,
  created: "2026-10-01T00:00:00.000Z",
  attached: false,
  ...extra
});

describe("tmux session groups", () => {
  const panes = [
    pane("%1", "main"),
    pane("%2", "gp"),
    pane("%3", "main"),
    pane("%4", "_hidden"),
    pane("%5", "gp")
  ];

  it("groups panes by tmux session in first-appearance order", () => {
    const { pinned, groups } = groupTmuxPanes(panes, []);
    expect(pinned).toEqual([]);
    expect(groups.map(({ session, panes: members }) => [session, members.map(({ name }) => name)])).toEqual([
      ["main", ["%1", "%3"]],
      ["gp", ["%2", "%5"]],
      ["_hidden", ["%4"]]
    ]);
  });

  it("lifts pinned panes out of their groups in server order and drops emptied groups", () => {
    const { pinned, groups } = groupTmuxPanes(panes, ["%5", "%4", "%1"]);
    expect(pinned.map(({ name }) => name)).toEqual(["%1", "%4", "%5"]);
    expect(groups.map(({ session, panes: members }) => [session, members.map(({ name }) => name)])).toEqual([
      ["main", ["%3"]],
      ["gp", ["%2"]]
    ]);
  });

  it("keeps legacy rows without a tmux session in one ungrouped bucket", () => {
    const { groups } = groupTmuxPanes([pane("agent-demo", undefined), pane("%1", "main"), pane("infra", undefined)], []);
    expect(groups.map(({ session, panes: members }) => [session, members.map(({ name }) => name)])).toEqual([
      [null, ["agent-demo", "infra"]],
      ["main", ["%1"]]
    ]);
  });

  it("shows the most attention-worthy pane status for a group: blocked > working > done > idle > unknown", () => {
    const aggregate = (...statuses: TmuxSessionStatusDto[]) => aggregateTmuxSessionStatus(
      statuses.map((status, index) => pane(`%${index + 1}`, "a", { status }))
    );
    expect(aggregate(UNKNOWN, IDLE, DONE, WORKING, QUESTION)).toEqual(QUESTION);
    expect(aggregate(UNKNOWN, IDLE, DONE, WORKING)).toEqual(WORKING);
    expect(aggregate(WORKING, DONE)).toEqual(WORKING);
    expect(aggregate(UNKNOWN, IDLE, DONE)).toEqual(DONE);
    expect(aggregate(UNKNOWN, IDLE)).toEqual(IDLE);
    expect(aggregate(UNKNOWN)).toEqual(UNKNOWN);
    expect(aggregate(PERMISSION, QUESTION)).toEqual(PERMISSION);
    expect(aggregateTmuxSessionStatus([pane("%1", "a", { status: WORKING }), pane("%2", "a")])).toEqual(WORKING);
    expect(aggregateTmuxSessionStatus([])).toEqual(tmuxPaneStatus(pane("%9", "a")));
    expect(tmuxPaneStatus(pane("%9", "a")).kind).toBe("unknown");
  });

  it("drops the redundant session prefix from pane details inside a group", () => {
    expect(tmuxPaneGroupDetail(pane("%1", "main", { label: "main:1.0 · zsh · ~/work" }))).toBe("1.0 · zsh · ~/work");
    expect(tmuxPaneGroupDetail(pane("%1", "main", { label: "other:1.0" }))).toBe("other:1.0");
    expect(tmuxPaneGroupDetail(pane("%1", "main"))).toBe("%1");
  });
});

describe("tmux session group expansion preferences", () => {
  it("collapses underscore sessions by default and expands the rest", () => {
    expect(defaultTmuxSessionGroupCollapsed("_hidden")).toBe(true);
    expect(defaultTmuxSessionGroupCollapsed("main")).toBe(false);
    expect(isTmuxSessionGroupCollapsed([], "_hidden")).toBe(true);
    expect(isTmuxSessionGroupCollapsed([], "gp")).toBe(false);
  });

  it("lets a stored choice override the default", () => {
    expect(isTmuxSessionGroupCollapsed([["_hidden", false]], "_hidden")).toBe(false);
    expect(isTmuxSessionGroupCollapsed([["gp", true]], "gp")).toBe(true);
  });

  it("stores only choices that differ from the default, most recent last", () => {
    let preferences = setTmuxSessionGroupCollapsed([], "gp", true);
    preferences = setTmuxSessionGroupCollapsed(preferences, "_hidden", false);
    expect(preferences).toEqual([["gp", true], ["_hidden", false]]);
    preferences = setTmuxSessionGroupCollapsed(preferences, "gp", true);
    expect(preferences).toEqual([["_hidden", false], ["gp", true]]);
    expect(setTmuxSessionGroupCollapsed(preferences, "_hidden", true)).toEqual([["gp", true]]);
    expect(setTmuxSessionGroupCollapsed(preferences, "gp", false)).toEqual([["_hidden", false]]);
  });

  it("caps stored choices so vanished sessions do not pile up", () => {
    let preferences = setTmuxSessionGroupCollapsed([], "first", true);
    for (let index = 0; index < MAX_STORED_TMUX_SESSION_GROUPS; index += 1) {
      preferences = setTmuxSessionGroupCollapsed(preferences, `s${index}`, true);
    }
    expect(preferences).toHaveLength(MAX_STORED_TMUX_SESSION_GROUPS);
    expect(isTmuxSessionGroupCollapsed(preferences, "first")).toBe(false);
    expect(isTmuxSessionGroupCollapsed(preferences, `s${MAX_STORED_TMUX_SESSION_GROUPS - 1}`)).toBe(true);
  });

  it("parses stored choices defensively", () => {
    expect(parseTmuxSessionGroupPreferences(null)).toEqual([]);
    expect(parseTmuxSessionGroupPreferences("not json")).toEqual([]);
    expect(parseTmuxSessionGroupPreferences(JSON.stringify({ gp: true }))).toEqual([]);
    expect(parseTmuxSessionGroupPreferences(JSON.stringify([
      ["gp", true],
      ["main", "yes"],
      ["", true],
      "junk",
      ["_hidden", true],
      ["_hidden", false],
      ["gp", true]
    ]))).toEqual([["_hidden", false], ["gp", true]]);
    const oversized = Array.from({ length: MAX_STORED_TMUX_SESSION_GROUPS + 5 }, (_, index) => [`s${index}`, true]);
    expect(parseTmuxSessionGroupPreferences(JSON.stringify(oversized))).toHaveLength(MAX_STORED_TMUX_SESSION_GROUPS);
  });
});

describe("tmux session ordering by last owner input", () => {
  it("sorts groups by their newest pane input and panes within a group, ties keeping server order", () => {
    const { pinned, groups } = groupTmuxPanes([
      pane("%1", "main", { lastInputAtMs: 100 }),
      pane("%2", "gp"),
      pane("%3", "main", { lastInputAtMs: 300 }),
      pane("%4", "fleet", { lastInputAtMs: 200 }),
      pane("%5", "main"),
      pane("%6", "gp"),
      pane("%7", "_hidden")
    ], ["%3"]);

    expect(pinned.map(({ name }) => name)).toEqual(["%3"]);
    expect(groups.map(({ session, panes: members }) => [session, members.map(({ name }) => name)])).toEqual([
      ["fleet", ["%4"]],
      ["main", ["%1", "%5"]],
      ["gp", ["%2", "%6"]],
      ["_hidden", ["%7"]]
    ]);
  });
});

describe("agent pane filter", () => {
  const entries = [
    pane("%1", "main", { currentCommand: "2.1.289" }),
    pane("%2", "gp", { currentCommand: "zsh" }),
    pane("%3", "gp", { currentCommand: "codex" }),
    pane("%4", "fleet", { currentCommand: "/opt/homebrew/bin/opencode" }),
    pane("%5", "fleet", { currentCommand: "pi" }),
    pane("%6", "lab", { currentCommand: "gpmonv2" }),
    pane("%7", "lab")
  ];

  it("lists only panes running claude, codex, opencode or pi by default", () => {
    expect(filterTmuxAgentPanes(entries, false, "").map(({ name }) => name)).toEqual(["%1", "%3", "%4", "%5"]);
    const { groups } = groupTmuxPanes(filterTmuxAgentPanes(entries, false, ""), []);
    expect(groups.map(({ session }) => session)).toEqual(["main", "gp", "fleet"]);
  });

  it("keeps the selected pane visible and shows everything when asked", () => {
    expect(filterTmuxAgentPanes(entries, false, "%2").map(({ name }) => name)).toEqual(["%1", "%2", "%3", "%4", "%5"]);
    expect(filterTmuxAgentPanes(entries, true, "")).toHaveLength(entries.length);
  });

  it("prefers the server's process-tree agent over tmux's foreground command", () => {
    const codexUnderNode = pane("%8", "main", { currentCommand: "node", agent: "codex" });
    const plainNode = pane("%9", "main", { currentCommand: "node" });
    expect(filterTmuxAgentPanes([codexUnderNode, plainNode], false, "").map(({ name }) => name)).toEqual(["%8"]);
  });
});

describe("unseen pane activity", () => {
  it("flags output newer than the last view, or than the first-run baseline", () => {
    const views = { baselineMs: 1000, viewed: [["%1", 5000]] as Array<[string, number]> };
    expect(hasUnseenTmuxActivity(views, pane("%1", "main", { activityAtMs: 6000 }))).toBe(true);
    expect(hasUnseenTmuxActivity(views, pane("%1", "main", { activityAtMs: 5000 }))).toBe(false);
    expect(hasUnseenTmuxActivity(views, pane("%2", "main", { activityAtMs: 2000 }))).toBe(true);
    expect(hasUnseenTmuxActivity(views, pane("%2", "main", { activityAtMs: 500 }))).toBe(false);
    expect(hasUnseenTmuxActivity(views, pane("%2", "main"))).toBe(false);
  });

  it("records views newest last and caps storage", () => {
    let views = markTmuxPanesViewed({ baselineMs: 1, viewed: [] }, ["%1", "%2"], 10);
    views = markTmuxPanesViewed(views, ["%1"], 20);
    expect(views.viewed).toEqual([["%2", 10], ["%1", 20]]);
    for (let index = 0; index < MAX_STORED_TMUX_PANE_VIEWS + 3; index += 1) {
      views = markTmuxPanesViewed(views, [`%${100 + index}`], 30);
    }
    expect(views.viewed).toHaveLength(MAX_STORED_TMUX_PANE_VIEWS);
    expect(views.viewed.some(([name]) => name === "%2")).toBe(false);
  });

  it("parses stored views defensively and starts the baseline now", () => {
    expect(parseTmuxPaneViews(null, 42)).toEqual({ baselineMs: 42, viewed: [] });
    expect(parseTmuxPaneViews("not json", 42)).toEqual({ baselineMs: 42, viewed: [] });
    expect(parseTmuxPaneViews(JSON.stringify({ baselineMs: 7, viewed: [["%1", 3], ["%2", "x"], ["", 4], ["%1", 9], 5] }), 42))
      .toEqual({ baselineMs: 7, viewed: [["%1", 9]] });
  });

  it("marks every pane of a tmux window together, since activity is per window", () => {
    const entries = [
      pane("%1", "main", { windowIndex: 0 }),
      pane("%2", "main", { windowIndex: 0 }),
      pane("%3", "main", { windowIndex: 1 }),
      pane("legacy", undefined)
    ];
    expect(tmuxWindowPaneNames(entries, "%2")).toEqual(["%1", "%2"]);
    expect(tmuxWindowPaneNames(entries, "%3")).toEqual(["%3"]);
    expect(tmuxWindowPaneNames(entries, "legacy")).toEqual(["legacy"]);
    expect(tmuxWindowPaneNames(entries, "%9")).toEqual(["%9"]);
    expect(tmuxWindowPaneNames(entries, "")).toEqual([]);
  });
});

describe("rail order and the pane after a snooze", () => {
  const rail = [
    pane("%1", "main", { lastInputAtMs: 300 }),
    pane("%2", "main", { lastInputAtMs: 200 }),
    pane("%3", "gp", { lastInputAtMs: 100 }),
    pane("%4", "_hidden", { lastInputAtMs: 900 }),
    pane("%5", "gp", { lastInputAtMs: 50 })
  ];

  it("lists pinned panes, then expanded groups, skipping collapsed ones", () => {
    expect(visibleTmuxRailPanes(rail, ["%5"], []).map((entry) => entry.name)).toEqual(["%5", "%1", "%2", "%3"]);
    expect(visibleTmuxRailPanes(rail, [], [["_hidden", false], ["main", true]]).map((entry) => entry.name)).toEqual(["%4", "%3", "%5"]);
  });

  it("selects the next row that stayed in place, else the previous one", () => {
    const before = visibleTmuxRailPanes(rail, [], []);
    // %1's window (with %2) moved to _hidden.
    const after = visibleTmuxRailPanes([
      pane("%1", "_hidden", { snoozedUntilMs: 1 }),
      pane("%2", "_hidden", { snoozedUntilMs: 1 }),
      pane("%3", "gp", { lastInputAtMs: 100 }),
      pane("%5", "gp", { lastInputAtMs: 50 })
    ], [], []);
    expect(nextTmuxRailPaneAfter(before, "%1", after)).toBe("%3");
    expect(nextTmuxRailPaneAfter(before, "%5", [pane("%1", "main"), pane("%2", "main"), pane("%3", "gp")])).toBe("%3");
  });

  it("falls back to the first unsnoozed row, or nothing", () => {
    expect(nextTmuxRailPaneAfter([], "%1", [pane("%1", "_hidden", { snoozedUntilMs: 1 }), pane("%9", "gp")])).toBe("%9");
    expect(nextTmuxRailPaneAfter([pane("%1", "main")], "%1", [pane("%1", "_hidden", { snoozedUntilMs: 1 })])).toBe("");
  });
});

describe("initial pane selection", () => {
  const agent = (name: string, session: string, lastInputAtMs: number, extra: Partial<TmuxSessionDto> = {}) =>
    pane(name, session, { currentCommand: "claude", lastInputAtMs, ...extra });
  // Raw tmux order: _hidden sorts first and holds the attached, active pane.
  const entries = [
    agent("%30", "_hidden", 900, { attached: true, windowActive: true, paneActive: true }),
    agent("%1", "gp", 100),
    pane("%2", "gp", { currentCommand: "zsh", lastInputAtMs: 800 }),
    agent("%3", "main", 500),
    agent("%4", "main", 50)
  ];
  const view = { pinnedNames: [], preferences: [], showAll: false };

  it("never defaults into _hidden: the rail's first agent row wins over raw order", () => {
    expect(initialTmuxPaneSelection(entries, null, view)).toBe("%3");
  });

  it("restores the stored pane while the rail still shows it", () => {
    expect(initialTmuxPaneSelection(entries, "%4", view)).toBe("%4");
    expect(initialTmuxPaneSelection(entries, "%gone", view)).toBe("%3");
  });

  it("skips a stored pane the rail hides: non-agent, collapsed group, or a default-collapsed _ session", () => {
    expect(initialTmuxPaneSelection(entries, "%2", view)).toBe("%3");
    expect(initialTmuxPaneSelection(entries, "%2", { ...view, showAll: true })).toBe("%2");
    expect(initialTmuxPaneSelection(entries, "%4", { ...view, preferences: [["main", true]] })).toBe("%1");
    expect(initialTmuxPaneSelection(entries, "%30", view)).toBe("%3");
  });

  it("restores a stored _hidden pane only when the owner expanded that group", () => {
    expect(initialTmuxPaneSelection(entries, "%30", { ...view, preferences: [["_hidden", false]] })).toBe("%30");
    // Expanded, but nothing stored: the default still skips _ sessions.
    expect(initialTmuxPaneSelection(entries, null, { ...view, preferences: [["_hidden", false]] })).toBe("%3");
  });

  it("puts pinned panes first, except pinned _ session panes", () => {
    expect(initialTmuxPaneSelection(entries, null, { ...view, pinnedNames: ["%4"] })).toBe("%4");
    expect(initialTmuxPaneSelection(entries, null, { ...view, pinnedNames: ["%30", "%1"] })).toBe("%1");
  });

  it("selects nothing when the rail shows nothing", () => {
    expect(initialTmuxPaneSelection([entries[0]!, entries[2]!], null, view)).toBe("");
    expect(initialTmuxPaneSelection(entries, "%3", { ...view, preferences: [["gp", true], ["main", true]] })).toBe("");
    expect(initialTmuxPaneSelection([], "%3", view)).toBe("");
  });
});
