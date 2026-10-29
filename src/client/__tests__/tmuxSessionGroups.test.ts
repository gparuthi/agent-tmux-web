import { describe, expect, it } from "vitest";

import type { TmuxSessionDto, TmuxSessionStatusDto } from "../../shared/api.js";
import {
  aggregateTmuxSessionStatus,
  defaultTmuxSessionGroupCollapsed,
  fallbackTmuxPaneSelection,
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
  tmuxGroupLastInputAtMs,
  tmuxPaneSelectionOnLoad,
  tmuxPaneStatus,
  tmuxRailPaneForDigit,
  tmuxRailShortcutPanes,
  tmuxSelectionAfterListChange,
  tmuxWindowPaneNames,
  visibleTmuxRailPanes,
  type TmuxRailView,
  type TmuxSessionGroupPreferences
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

  it("lists every ordinary session's panes in one flat list, with only _ sessions grouped after it", () => {
    const { pinned, groups } = groupTmuxPanes(panes, []);
    expect(pinned).toEqual([]);
    expect(groups.map(({ session, panes: members }) => [session, members.map(({ name }) => name)])).toEqual([
      [null, ["%1", "%2", "%3", "%5"]],
      ["_hidden", ["%4"]]
    ]);
  });

  it("lifts pinned panes out of the list, server order on ties, and drops an emptied _ group", () => {
    const { pinned, groups } = groupTmuxPanes(panes, ["%5", "%4", "%1"]);
    expect(pinned.map(({ name }) => name)).toEqual(["%1", "%4", "%5"]);
    expect(groups.map(({ session, panes: members }) => [session, members.map(({ name }) => name)])).toEqual([
      [null, ["%2", "%3"]]
    ]);
  });

  it("keeps legacy rows without a tmux session in the flat list", () => {
    const { groups } = groupTmuxPanes([pane("agent-demo", undefined), pane("%1", "main"), pane("infra", undefined)], []);
    expect(groups.map(({ session, panes: members }) => [session, members.map(({ name }) => name)])).toEqual([
      [null, ["agent-demo", "%1", "infra"]]
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
  it("sorts the flat list newest input first across sessions, ties keeping server order", () => {
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
      [null, ["%4", "%1", "%2", "%5", "%6"]],
      ["_hidden", ["%7"]]
    ]);
  });

  it("puts dated panes before undated ones, newest first, and keeps equal times in server order", () => {
    const order = (entries: TmuxSessionDto[]) => groupTmuxPanes(entries, []).groups[0]!.panes.map(({ name }) => name);
    const entries = [
      pane("%1", "main"),
      pane("%2", "gp", { lastInputAtMs: 500 }),
      pane("%3", "main", { lastInputAtMs: 900 }),
      pane("%4", "lab"),
      pane("%5", "gp", { lastInputAtMs: 500 }),
      pane("%6", "lab", { lastInputAtMs: 500 })
    ];
    expect(order(entries)).toEqual(["%3", "%2", "%5", "%6", "%1", "%4"]);
    // The same times on the next poll give the same order, however often it is recomputed.
    expect(order(entries.map((entry) => ({ ...entry })))).toEqual(order(entries));
    // Only a changed time moves a row: %6 typed into now jumps to the top, the rest keep their places.
    expect(order(entries.map((entry) => entry.name === "%6" ? { ...entry, lastInputAtMs: 1000 } : entry)))
      .toEqual(["%6", "%3", "%2", "%5", "%1", "%4"]);
  });

  it("pins sort newest first too", () => {
    const { pinned } = groupTmuxPanes([pane("%1", "main", { lastInputAtMs: 1 }), pane("%2", "gp"), pane("%3", "gp", { lastInputAtMs: 9 })], ["%1", "%2", "%3"]);
    expect(pinned.map(({ name }) => name)).toEqual(["%3", "%1", "%2"]);
  });

  it("gives a session its newest pane input, 0 when no pane has one", () => {
    expect(tmuxGroupLastInputAtMs([
      pane("%1", "main", { lastInputAtMs: 100 }),
      pane("%2", "main"),
      pane("%3", "main", { lastInputAtMs: 300 })
    ])).toBe(300);
    expect(tmuxGroupLastInputAtMs([pane("%1", "main"), pane("%2", "main")])).toBe(0);
    expect(tmuxGroupLastInputAtMs([])).toBe(0);
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
    expect(groups.map(({ session, panes: members }) => [session, members.map(({ name }) => name)])).toEqual([[null, ["%1", "%3", "%4", "%5"]]]);
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

  it("lists pinned panes, then the flat list, then expanded _ groups, skipping collapsed ones", () => {
    expect(visibleTmuxRailPanes(rail, ["%5"], []).map((entry) => entry.name)).toEqual(["%5", "%1", "%2", "%3"]);
    // A stored collapse choice for an ordinary session no longer hides anything.
    expect(visibleTmuxRailPanes(rail, [], [["_hidden", false], ["main", true]]).map((entry) => entry.name)).toEqual(["%1", "%2", "%3", "%5", "%4"]);
  });

  const all: TmuxRailView = { pinnedNames: [], preferences: [], showAll: true };

  it("selects the next row that stayed in place, else the previous one", () => {
    const before = visibleTmuxRailPanes(rail, [], []);
    // %1's window (with %2) moved to _hidden.
    const after = [
      pane("%1", "_hidden", { snoozedUntilMs: 1 }),
      pane("%2", "_hidden", { snoozedUntilMs: 1 }),
      pane("%3", "gp", { lastInputAtMs: 100 }),
      pane("%5", "gp", { lastInputAtMs: 50 })
    ];
    expect(nextTmuxRailPaneAfter(before, "%1", after, all)).toBe("%3");
    expect(nextTmuxRailPaneAfter(before, "%5", [pane("%1", "main"), pane("%2", "main"), pane("%3", "gp")], all)).toBe("%3");
  });

  it("falls back to the first unsnoozed row, or nothing", () => {
    expect(nextTmuxRailPaneAfter([], "%1", [pane("%1", "_hidden", { snoozedUntilMs: 1 }), pane("%9", "gp")], all)).toBe("%9");
    expect(nextTmuxRailPaneAfter([pane("%1", "main")], "%1", [pane("%1", "_hidden", { snoozedUntilMs: 1 })], all)).toBe("");
  });
});

describe("the pane after a close, snooze or vanished pane", () => {
  const agent = (name: string, session: string, lastInputAtMs: number, extra: Partial<TmuxSessionDto> = {}) =>
    pane(name, session, { currentCommand: "claude", lastInputAtMs, ...extra });
  // Rail order (agents only): %3, %1, %4 by last input; zsh %2 is filtered out.
  const entries = [
    agent("%30", "_hidden", 900, { attached: true, windowActive: true, paneActive: true }),
    agent("%31", "_ctr_bootstrap", 950),
    agent("%1", "gp", 100),
    pane("%2", "gp", { currentCommand: "zsh", lastInputAtMs: 800 }),
    agent("%3", "main", 500),
    agent("%4", "main", 50)
  ];
  const view: TmuxRailView = { pinnedNames: [], preferences: [], showAll: false };
  const rail = (list: TmuxSessionDto[], selected: string, v = view) =>
    visibleTmuxRailPanes(filterTmuxAgentPanes(list, v.showAll, selected), v.pinnedNames, v.preferences);
  const without = (name: string) => entries.filter((entry) => entry.name !== name);

  it("takes the next rail row, else the previous one, never raw tmux order", () => {
    expect(nextTmuxRailPaneAfter(rail(entries, "%3"), "%3", without("%3"), view)).toBe("%1");
    expect(nextTmuxRailPaneAfter(rail(entries, "%1"), "%1", without("%1"), view)).toBe("%4");
  });

  it("skips non-agent panes unless showing all", () => {
    const before = rail(entries, "%4");
    expect(nextTmuxRailPaneAfter(before, "%4", without("%4"), view)).toBe("%1");
    const allView = { ...view, showAll: true };
    // Show all: zsh %2 has the newest input, so it heads the rail.
    expect(fallbackTmuxPaneSelection(entries, view)).toBe("%3");
    expect(fallbackTmuxPaneSelection(entries, allView)).toBe("%2");
    expect(nextTmuxRailPaneAfter(rail(entries, "%3", allView), "%3", without("%3"), allView)).toBe("%1");
    expect(nextTmuxRailPaneAfter(rail(entries, "%4", allView), "%4", without("%4"), allView)).toBe("%1");
  });

  it("never lands in _hidden or another _ session, even when the owner expanded it", () => {
    const expanded: TmuxRailView = { ...view, preferences: [["_hidden", false], ["_ctr_bootstrap", false]] };
    const before = rail(entries, "%1", expanded);
    expect(before.map((entry) => entry.name)).toContain("%30");
    expect(nextTmuxRailPaneAfter(before, "%1", without("%1"), expanded)).toBe("%4");
    const onlyHidden = [entries[0]!, entries[1]!, agent("%9", "gp", 1)];
    expect(nextTmuxRailPaneAfter(rail(onlyHidden, "%9", expanded), "%9", onlyHidden.slice(0, 2), expanded)).toBe("");
    expect(fallbackTmuxPaneSelection(onlyHidden.slice(0, 2), expanded)).toBe("");
  });

  it("ignores collapse choices for ordinary sessions and honours pins", () => {
    const collapsed: TmuxRailView = { ...view, preferences: [["main", true]] };
    expect(nextTmuxRailPaneAfter(rail(entries, "%1", view), "%1", without("%1"), collapsed)).toBe("%4");
    const pinned = { ...view, pinnedNames: ["%4"] };
    expect(nextTmuxRailPaneAfter(rail(entries, "%3", pinned), "%3", without("%3"), pinned)).toBe("%1");
    expect(fallbackTmuxPaneSelection(without("%3"), pinned)).toBe("%4");
  });

  it("moves on when a refresh drops the selected pane, and only then", () => {
    expect(tmuxSelectionAfterListChange(entries, without("%3"), "%3", view)).toBe("%1");
    expect(tmuxSelectionAfterListChange(entries, entries, "%3", view)).toBeNull();
    // A deep-linked pane the previous list never had keeps its selection.
    expect(tmuxSelectionAfterListChange(without("%7"), without("%7"), "%7", view)).toBeNull();
    expect(tmuxSelectionAfterListChange([], entries, "%3", view)).toBeNull();
    expect(tmuxSelectionAfterListChange(entries, without("%3"), "", view)).toBeNull();
    expect(tmuxSelectionAfterListChange(entries, [entries[0]!], "%3", view)).toBe("");
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

  it("restores the stored pane while tmux still lists it, else the rail's first row", () => {
    expect(initialTmuxPaneSelection(entries, "%4", view)).toBe("%4");
    expect(initialTmuxPaneSelection(entries, "%gone", view)).toBe("%3");
  });

  it("restores a non-agent pane, which the agent filter keeps in the rail once selected", () => {
    const selected = initialTmuxPaneSelection(entries, "%2", view);
    expect(selected).toBe("%2");
    expect(filterTmuxAgentPanes(entries, false, selected).map((entry) => entry.name)).toContain("%2");
  });

  it("restores a pane in a collapsed group and leaves the group collapsed", () => {
    const collapsed = { ...view, preferences: [["main", true]] as TmuxSessionGroupPreferences };
    expect(initialTmuxPaneSelection(entries, "%4", collapsed)).toBe("%4");
    expect(initialTmuxPaneSelection(entries, "%3", { ...view, preferences: [["gp", true], ["main", true]] })).toBe("%3");
    expect(isTmuxSessionGroupCollapsed(collapsed.preferences, "main")).toBe(true);
  });

  it("restores a stored _hidden pane only when the owner expanded that group", () => {
    expect(initialTmuxPaneSelection(entries, "%30", view)).toBe("%3");
    expect(initialTmuxPaneSelection(entries, "%30", { ...view, preferences: [["_hidden", true]] })).toBe("%3");
    expect(initialTmuxPaneSelection(entries, "%30", { ...view, preferences: [["_hidden", false]] })).toBe("%30");
    // Expanded, but nothing stored: the default still skips _ sessions.
    expect(initialTmuxPaneSelection(entries, null, { ...view, preferences: [["_hidden", false]] })).toBe("%3");
  });

  it("falls back from a snoozed pane, even with _hidden expanded", () => {
    const snoozed = [...entries, agent("%31", "_hidden", 950, { snoozedUntilMs: 9_999 })];
    expect(initialTmuxPaneSelection(snoozed, "%31", view)).toBe("%3");
    expect(initialTmuxPaneSelection(snoozed, "%31", { ...view, preferences: [["_hidden", false]] })).toBe("%3");
  });

  it("lets a selection made before the listing arrived (a deep link) win over the stored pane", () => {
    expect(tmuxPaneSelectionOnLoad("%1", entries, "%4", view)).toBe("%1");
    expect(tmuxPaneSelectionOnLoad("", entries, "%4", view)).toBe("%4");
    expect(tmuxPaneSelectionOnLoad("", entries, null, view)).toBe("%3");
  });

  it("puts pinned panes first, except pinned _ session panes", () => {
    expect(initialTmuxPaneSelection(entries, null, { ...view, pinnedNames: ["%4"] })).toBe("%4");
    expect(initialTmuxPaneSelection(entries, null, { ...view, pinnedNames: ["%30", "%1"] })).toBe("%1");
  });

  it("selects nothing when the rail shows nothing", () => {
    expect(initialTmuxPaneSelection([entries[0]!, entries[2]!], null, view)).toBe("");
    expect(initialTmuxPaneSelection([], "%3", view)).toBe("");
    // Ordinary sessions can no longer be collapsed away, so the flat list still has a row.
    expect(initialTmuxPaneSelection(entries, "%30", { ...view, preferences: [["gp", true], ["main", true]] })).toBe("%3");
  });
});

describe("number-key rail shortcuts", () => {
  const rail = [
    pane("%1", "main", { lastInputAtMs: 300, currentCommand: "claude" }),
    pane("%2", "main", { lastInputAtMs: 200, currentCommand: "codex" }),
    pane("%3", "gp", { lastInputAtMs: 100, currentCommand: "claude" }),
    pane("%4", "_hidden", { lastInputAtMs: 900, currentCommand: "claude" }),
    pane("%5", "gp", { lastInputAtMs: 50, currentCommand: "pi" }),
    pane("%6", "gp", { lastInputAtMs: 999, currentCommand: "zsh" })
  ];
  const agents = filterTmuxAgentPanes(rail, false, "");

  it("maps 1-9 to the visible rows in rail order, skipping collapsed groups and hidden panes", () => {
    // %4 sits in collapsed _hidden; %6 is a shell the agent filter hides.
    expect(tmuxRailShortcutPanes(agents, [], [])).toEqual(["%1", "%2", "%3", "%5"]);
    expect(tmuxRailPaneForDigit(agents, [], [], 1)).toBe("%1");
    expect(tmuxRailPaneForDigit(agents, [], [], 3)).toBe("%3");
    expect(tmuxRailPaneForDigit(agents, [], [], 5)).toBe("");
  });

  it("counts pinned rows first and follows the owner's expanded and collapsed _ groups", () => {
    expect(tmuxRailPaneForDigit(agents, ["%5"], [], 1)).toBe("%5");
    expect(tmuxRailPaneForDigit(agents, ["%5"], [], 2)).toBe("%1");
    expect(tmuxRailShortcutPanes(agents, [], [["_hidden", false], ["main", true]])).toEqual(["%1", "%2", "%3", "%5", "%4"]);
    // A pinned pane from a collapsed _ group stays reachable.
    expect(tmuxRailShortcutPanes(agents, ["%4"], [])).toEqual(["%4", "%1", "%2", "%3", "%5"]);
  });

  it("numbers only the first nine rows and ignores digits outside 1-9", () => {
    const many = Array.from({ length: 12 }, (_, index) => pane(`%${index + 1}`, "main", { lastInputAtMs: 100 - index }));
    expect(tmuxRailShortcutPanes(many, [], [])).toHaveLength(9);
    expect(tmuxRailPaneForDigit(many, [], [], 9)).toBe("%9");
    expect(tmuxRailPaneForDigit(many, [], [], 10)).toBe("");
    expect(tmuxRailPaneForDigit(many, [], [], 0)).toBe("");
    expect(tmuxRailPaneForDigit(many, [], [], 1.5)).toBe("");
  });
});
