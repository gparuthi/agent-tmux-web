import { describe, expect, it } from "vitest";

import type { TmuxSessionDto, TmuxSessionStatusDto } from "../../shared/api.js";
import {
  aggregateTmuxSessionStatus,
  defaultTmuxSessionGroupCollapsed,
  filterTmuxAgentPanes,
  groupTmuxPanes,
  hasUnseenTmuxActivity,
  isTmuxSessionGroupCollapsed,
  markTmuxPanesViewed,
  MAX_STORED_TMUX_PANE_VIEWS,
  MAX_STORED_TMUX_SESSION_GROUPS,
  parseTmuxPaneViews,
  parseTmuxSessionGroupPreferences,
  setTmuxSessionGroupCollapsed,
  tmuxPaneGroupDetail,
  tmuxPaneStatus,
  tmuxWindowPaneNames
} from "../tmuxSessionGroups.js";

const RUNNING: TmuxSessionStatusDto = { kind: "running", health: "green", title: "Running" };
const QUESTION: TmuxSessionStatusDto = { kind: "question", health: "amber", title: "Choice required" };
const PERMISSION: TmuxSessionStatusDto = { kind: "needs-permission", health: "amber", title: "Needs permission" };
const ERROR: TmuxSessionStatusDto = { kind: "error", health: "red", title: "Error" };

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

  it("shows the most attention-worthy pane status for a group", () => {
    expect(aggregateTmuxSessionStatus([pane("%1", "a", { status: RUNNING }), pane("%2", "a")])).toEqual(RUNNING);
    expect(aggregateTmuxSessionStatus([pane("%1", "a", { status: RUNNING }), pane("%2", "a", { status: QUESTION })])).toEqual(QUESTION);
    expect(aggregateTmuxSessionStatus([pane("%1", "a", { status: QUESTION }), pane("%2", "a", { status: ERROR })])).toEqual(ERROR);
    expect(aggregateTmuxSessionStatus([pane("%1", "a", { status: PERMISSION }), pane("%2", "a", { status: QUESTION })])).toEqual(PERMISSION);
    expect(aggregateTmuxSessionStatus([])).toEqual(tmuxPaneStatus(pane("%9", "a")));
    expect(tmuxPaneStatus(pane("%9", "a")).health).toBe("gray");
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
