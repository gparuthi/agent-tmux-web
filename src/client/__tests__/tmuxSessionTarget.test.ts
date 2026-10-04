import { describe, expect, it } from "vitest";

import type { TmuxSessionDto } from "../../shared/api.js";
import {
  defaultTmuxPaneSelection,
  findTmuxPaneForSession,
  formatTmuxStatusText,
  orderTmuxSessionsByPins,
  parsePinnedTmuxSessionNames,
  readRequestedTmuxSession,
  removeRequestedTmuxSession,
  tmuxPaneRowLabel,
  tmuxPaneShortName,
  tmuxSessionGroupHeader,
  togglePinnedTmuxSessionName
} from "../tmuxSessionTarget.js";

describe("tmux session notification targets", () => {
  it("reads the requested tmux session from the URL query", () => {
    expect(readRequestedTmuxSession("?token=abc&tmuxSession=agent-demo")).toBe("agent-demo");
  });

  it("trims and ignores blank requested sessions", () => {
    expect(readRequestedTmuxSession("?tmuxSession=%20codex%20")).toBe("codex");
    expect(readRequestedTmuxSession("?tmuxSession=%20%20")).toBe("");
  });

  it("removes the consumed session target without dropping auth token", () => {
    const url = new URL("https://example.test/?token=abc&tmuxSession=agent-demo");

    expect(removeRequestedTmuxSession(url)).toBe("https://example.test/?token=abc");
  });

  it("parses, deduplicates, and toggles pinned session names", () => {
    expect(parsePinnedTmuxSessionNames(JSON.stringify([" admin ", "admin", 4, "health"]))).toEqual(["admin", "health"]);
    expect(parsePinnedTmuxSessionNames("not json")).toEqual([]);
    expect(togglePinnedTmuxSessionName(["admin"], "health")).toEqual(["admin", "health"]);
    expect(togglePinnedTmuxSessionName(["admin", "health"], "admin")).toEqual(["health"]);
  });

  it("moves pinned sessions to the top without reordering either group", () => {
    const session = (name: string): TmuxSessionDto => ({ name, windows: 1, created: "now", attached: false });
    const ordered = orderTmuxSessionsByPins(
      [session("admin"), session("agent-tmux-web"), session("health"), session("kartbite")],
      ["health", "admin"]
    );

    expect(ordered.map(({ name }) => name)).toEqual(["admin", "health", "agent-tmux-web", "kartbite"]);
  });
});

describe("tmux pane entries", () => {
  const pane = (name: string, session: string, windowIndex: number, paneIndex: number, extra: Partial<TmuxSessionDto> = {}): TmuxSessionDto => ({
    name,
    session,
    paneId: name.replace(/^.*(?=%)/, ""),
    windowIndex,
    paneIndex,
    label: `${session}:${windowIndex}.${paneIndex} \u00b7 zsh \u00b7 ~/work`,
    windows: 2,
    created: "2026-10-01T00:00:00.000Z",
    attached: false,
    ...extra
  });
  const panes = [
    pane("%1", "gp", 0, 0),
    pane("%7", "gp", 0, 1),
    pane("%32", "main", 0, 0, { attached: true }),
    pane("%20", "main", 1, 0, { attached: true, windowActive: true, paneActive: true })
  ];

  it("labels rows without repeating the session header", () => {
    expect(tmuxPaneShortName(panes[3])).toBe("main:1.0");
    expect(tmuxPaneRowLabel(panes[3])).toBe("1.0 \u00b7 zsh \u00b7 ~/work");
    expect(tmuxPaneShortName({ name: "legacy", windows: 1, created: "", attached: false })).toBe("legacy");
  });

  it("emits a session header at the start of each run of panes", () => {
    expect(panes.map((_, index) => tmuxSessionGroupHeader(panes, index))).toEqual(["gp", null, "main", null]);
  });

  it("picks the active pane of an attached session by default", () => {
    expect(defaultTmuxPaneSelection(panes)).toBe("%20");
    expect(defaultTmuxPaneSelection(panes.slice(0, 2))).toBe("%1");
    expect(defaultTmuxPaneSelection([])).toBe("");
  });

  it("finds the pane to select after creating a session", () => {
    expect(findTmuxPaneForSession(panes, "main")?.name).toBe("%20");
    expect(findTmuxPaneForSession(panes, "gp")?.name).toBe("%1");
    expect(findTmuxPaneForSession(panes, "missing")).toBeUndefined();
  });

  it("replaces pane ids in status text with readable pane names", () => {
    expect(formatTmuxStatusText("live terminal for %20", panes)).toBe("live terminal for main:1.0");
    expect(formatTmuxStatusText("sent to %7; following output", panes)).toBe("sent to gp:0.1; following output");
    expect(formatTmuxStatusText("%99 is idle", panes)).toBe("%99 is idle");
    expect(formatTmuxStatusText("50% done", panes)).toBe("50% done");
  });
});
