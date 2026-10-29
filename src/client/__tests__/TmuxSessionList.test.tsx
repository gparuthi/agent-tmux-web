import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { TmuxSessionDto } from "../../shared/api.js";
import { formatTmuxLastPrompt, formatTmuxPaneState, TmuxSessionList } from "../TmuxSessionList.js";
import type { TmuxPaneViews, TmuxSessionGroupPreferences } from "../tmuxSessionGroups.js";

const pane = (name: string, session: string, extra: Partial<TmuxSessionDto> = {}): TmuxSessionDto => ({
  name,
  session,
  windows: 1,
  created: "2026-10-01T00:00:00.000Z",
  attached: false,
  label: `${session}:0.0 · zsh · ~/work`,
  ...extra
});

const panes = [
  pane("%1", "main", { displayName: "build agent", status: { kind: "working", title: "Working" } }),
  pane("%2", "gp", { displayName: "notes" }),
  pane("%3", "_hidden", { displayName: "shim", status: { kind: "blocked", title: "Needs permission" } }),
  pane("%4", "_hidden", { displayName: "worker" })
];

const allSeen: TmuxPaneViews = { baselineMs: Number.MAX_SAFE_INTEGER, viewed: [] };

function render(selected: string, pinnedNames: string[] = [], groupPreferences: TmuxSessionGroupPreferences = [], paneViews = allSeen, entries = panes) {
  return renderToStaticMarkup(
    <TmuxSessionList
      groupPreferences={groupPreferences}
      paneViews={paneViews}
      panes={entries}
      pinnedNames={pinnedNames}
      selected={selected}
      onSelect={vi.fn()}
     
      onToggleGroup={vi.fn()}
    />
  );
}

describe("TmuxSessionList", () => {
  it("lists ordinary sessions flat with the session in the sub-line, and collapses underscore sessions", () => {
    const html = render("%1");

    expect(html).not.toContain('aria-label="main, 1 pane"');
    expect(html).not.toContain('aria-label="gp, 1 pane"');
    expect(html.match(/tmux-session-group-header/g)).toHaveLength(1);
    expect(html).toContain('aria-expanded="false" aria-label="_hidden, 2 panes, Needs permission"');
    expect(html).toContain('<span class="tmux-session-name">build agent</span><span class="tmux-session-sub"><span class="tmux-session-sub-session">main</span><span aria-hidden="true" class="tmux-session-sub-separator">·</span><span class="tmux-session-sub-state">working</span></span>');
    expect(html).not.toContain("worker");
    expect(html).toContain('class="tmux-session-status-dot blocked"');
    // The main line is just the title: no detail text and no per-row pin button.
    expect(html).not.toContain("tmux-session-detail");
    expect(html).not.toContain("tmux-session-pin");
    expect(html).toMatch(/title="build agent \(main:0\.0 · zsh · ~\/work\)/);
  });

  it("marks a collapsed group that holds the selected pane without expanding it", () => {
    const html = render("%4");

    expect(html).toContain("tmux-session-group-header contains-active");
    expect(html).toContain("_hidden, 2 panes, Needs permission, selected pane inside");
    expect(html).not.toContain("worker");
  });

  it("follows stored expansion choices for _ sessions and ignores old ones for ordinary sessions", () => {
    const html = render("%2", [], [["_hidden", false], ["main", true]]);

    expect(html).toContain('aria-expanded="true" aria-label="_hidden, 2 panes"');
    expect(html).toContain("worker");
    expect(html).not.toContain('aria-label="main, 1 pane');
    expect(html).toContain("build agent");
  });

  it("lists pinned panes once, in a Pinned section above the groups", () => {
    const html = render("%1", ["%4"]);

    expect(html.indexOf("Pinned")).toBeLessThan(html.indexOf("build agent"));
    expect(html.match(/>worker</g)).toHaveLength(1);
    expect(html).toContain('<span class="tmux-session-name">worker</span><span class="tmux-session-sub"><span class="tmux-session-sub-session">_hidden</span></span>');
    expect(html).toContain('aria-label="_hidden, 1 pane, Needs permission"');
  });

  it("dims rows and headers unless a pane has output since it was last viewed", () => {
    const views: TmuxPaneViews = { baselineMs: 1000, viewed: [["%2", 5000]] };
    const html = render("%1", [], [], views, [
      pane("%1", "main", { displayName: "build agent", activityAtMs: 9000 }),
      pane("%2", "gp", { displayName: "notes", activityAtMs: 4000 }),
      pane("%3", "_hidden", { displayName: "shim", activityAtMs: 2000 })
    ]);

    expect(html).toContain('class="tmux-session-row active "');
    expect(html).toContain('class="tmux-session-row  "');
    expect(html).toContain('aria-label="_hidden, 1 pane, Unknown, new output"');
    expect(html).toMatch(/tmux-session-group-header +unseen/);
  });

  it("shows a snoozed pane's wake time and a Wake button only when waking is available", () => {
    const nowMs = new Date(2026, 9, 4, 14, 0).getTime();
    const entries = [
      pane("%1", "main", { displayName: "build agent" }),
      pane("%8", "_hidden", { displayName: "camera eval", snoozedUntilMs: nowMs + 3 * 60 * 60_000 })
    ];
    const onWake = vi.fn();
    const props = { groupPreferences: [["_hidden", false]] as TmuxSessionGroupPreferences, paneViews: allSeen, panes: entries, pinnedNames: [], selected: "%1", onSelect: vi.fn(), onToggleGroup: vi.fn(), nowMs };
    const html = renderToStaticMarkup(<TmuxSessionList {...props} onWake={onWake} />);

    expect(html).toContain('<span class="tmux-session-wake">wakes 3h</span>');
    expect(html).toContain('class="tmux-session-row   snoozed"');
    expect(html).toContain('aria-label="Wake camera eval now"');
    expect(html.match(/tmux-session-wake-button/g)).toHaveLength(1);

    const readOnly = renderToStaticMarkup(<TmuxSessionList {...props} />);
    expect(readOnly).toContain("wakes 3h");
    expect(readOnly).not.toContain("tmux-session-wake-button");
  });

  it("marks a pane stale after three days without input unless it is snoozed", () => {
    const nowMs = new Date(2026, 9, 20, 12, 0).getTime();
    const day = 24 * 60 * 60_000;
    const entries = [
      pane("%1", "main", { displayName: "fresh", lastInputAtMs: nowMs - 2 * day }),
      pane("%2", "main", { displayName: "old", lastInputAtMs: nowMs - 5 * day - 60_000 }),
      pane("%3", "main", { displayName: "parked", lastInputAtMs: nowMs - 9 * day, snoozedUntilMs: nowMs + day }),
      pane("%4", "main", { displayName: "unknown" })
    ];
    const html = renderToStaticMarkup(
      <TmuxSessionList groupPreferences={[]} paneViews={allSeen} panes={entries} pinnedNames={[]} selected="%1" nowMs={nowMs} onSelect={vi.fn()} onToggleGroup={vi.fn()} />
    );

    expect(html.match(/class="tmux-session-stale"/g)).toHaveLength(1);
    expect(html).toContain('<span class="tmux-session-stale">5d idle</span>');
    expect(html).toMatch(/title="old \([^"]*, possibly stale, 5d idle/);
    expect(html.match(/ stale"/g)).toHaveLength(1);
  });

  it("hints keys 1-9 on the first nine visible rows only", () => {
    const html = render("%1", ["%2"]);

    // Pinned %2 first, then main's %1; _hidden is collapsed, so its rows take no number.
    expect(html.match(/class="tmux-session-shortcut"/g)).toHaveLength(2);
    expect(html).toMatch(/aria-keyshortcuts="1 Alt\+1"[^>]*title="notes/);
    expect(html).toMatch(/aria-keyshortcuts="2 Alt\+2"[^>]*title="build agent/);
    expect(html).toContain('<span aria-hidden="true" class="tmux-session-shortcut">1</span>');

    const many = Array.from({ length: 11 }, (_, index) => pane(`%${index + 1}`, "main", { displayName: `agent ${index + 1}`, lastInputAtMs: 100 - index }));
    const long = render("%1", [], [], allSeen, many);
    expect(long.match(/class="tmux-session-shortcut"/g)).toHaveLength(9);
    expect(long).toContain('class="tmux-session-shortcut">9</span>');
    expect(long).not.toMatch(/aria-keyshortcuts="[^"]*"[^>]*title="agent 10 /);
  });

  it("formats the last prompt as just now, minutes, hours or days ago", () => {
    const nowMs = new Date(2026, 9, 20, 12, 0).getTime();
    const minute = 60_000;
    expect(formatTmuxLastPrompt(undefined, nowMs)).toBe("");
    expect(formatTmuxLastPrompt(0, nowMs)).toBe("");
    expect(formatTmuxLastPrompt(nowMs - 59_000, nowMs)).toBe("just now");
    // A slightly fast client clock never shows a negative age.
    expect(formatTmuxLastPrompt(nowMs + 5_000, nowMs)).toBe("just now");
    expect(formatTmuxLastPrompt(nowMs - minute, nowMs)).toBe("1m ago");
    expect(formatTmuxLastPrompt(nowMs - 59 * minute - 59_000, nowMs)).toBe("59m ago");
    expect(formatTmuxLastPrompt(nowMs - 60 * minute, nowMs)).toBe("1h ago");
    expect(formatTmuxLastPrompt(nowMs - (23 * 60 + 59) * minute, nowMs)).toBe("23h ago");
    expect(formatTmuxLastPrompt(nowMs - 24 * 60 * minute, nowMs)).toBe("1d ago");
    expect(formatTmuxLastPrompt(nowMs - 9 * 24 * 60 * minute - 5 * 60 * minute, nowMs)).toBe("9d ago");
  });

  it("shows session:window and the last prompt under each pane name, and a collapsed _ header's newest", () => {
    const nowMs = new Date(2026, 9, 20, 12, 0).getTime();
    const hour = 60 * 60_000;
    const entries = [
      pane("%1", "main", { displayName: "build agent", windowIndex: 5, paneIndex: 0, lastInputAtMs: nowMs - 3 * hour }),
      pane("%2", "main", { displayName: "notes", windowIndex: 6, paneIndex: 1 }),
      pane("%3", "_hidden", { displayName: "shim", windowIndex: 1, paneIndex: 0, lastInputAtMs: nowMs - 50 * hour }),
      pane("%4", "_hidden", { displayName: "worker", windowIndex: 2, paneIndex: 0, lastInputAtMs: nowMs - 5 * 60_000 }),
      pane("legacy", "", { session: undefined, displayName: "old row", lastInputAtMs: nowMs - 2 * hour }),
      pane("bare", "", { session: undefined, displayName: "bare row" })
    ];
    const html = renderToStaticMarkup(
      <TmuxSessionList groupPreferences={[]} paneViews={allSeen} panes={entries} pinnedNames={[]} selected="%1" nowMs={nowMs} onSelect={vi.fn()} onToggleGroup={vi.fn()} />
    );

    expect(html).toContain('<span class="tmux-session-title"><span class="tmux-session-name">build agent</span><span class="tmux-session-sub"><span class="tmux-session-sub-session">main</span><span class="tmux-session-sub-window">:5</span><span aria-hidden="true" class="tmux-session-sub-separator">·</span><span class="tmux-session-last-prompt">3h ago</span></span></span>');
    // No known prompt: the target alone, no "never".
    expect(html).toContain('<span class="tmux-session-sub"><span class="tmux-session-sub-session">main</span><span class="tmux-session-sub-window">:6.1</span></span>');
    expect(html).toContain('<span class="tmux-session-name">old row</span><span class="tmux-session-sub"><span class="tmux-session-last-prompt">2h ago</span></span>');
    expect(html).toContain('<span class="tmux-session-title"><span class="tmux-session-name">bare row</span></span>');
    expect(html).not.toContain("never");
    expect(html).toMatch(/title="build agent \([^"]*, last prompt 3h ago/);
    // _hidden is collapsed: its header carries the newest of its panes.
    expect(html).toContain('aria-label="_hidden, 2 panes, Unknown, last prompt 5m ago"');
    expect(html).toContain('<span aria-hidden="true" class="tmux-session-group-time">5m ago</span>');
    expect(html.match(/class="tmux-session-group-time"/g)).toHaveLength(1);
    // Flat rows newest first: build agent (3h), old row (2h ago is newer), then undated rows in server order.
    const names = [...html.matchAll(/class="tmux-session-name">([^<]+)</g)].map((match) => match[1]);
    expect(names).toEqual(["old row", "build agent", "notes", "bare row"]);

    const expanded = renderToStaticMarkup(
      <TmuxSessionList groupPreferences={[["_hidden", false]]} paneViews={allSeen} panes={entries} pinnedNames={[]} selected="%1" nowMs={nowMs} onSelect={vi.fn()} onToggleGroup={vi.fn()} />
    );
    expect(expanded).not.toContain("tmux-session-group-time");
    expect(expanded).toContain('<span class="tmux-session-sub-session">_hidden</span><span class="tmux-session-sub-window">:2</span>');
  });

  it("words the status dot's state, keeping a blocked pane's reason", () => {
    expect(formatTmuxPaneState(pane("%1", "main", { status: { kind: "working", title: "Working" } }))).toBe("working");
    expect(formatTmuxPaneState(pane("%1", "main", { status: { kind: "idle", title: "Idle 12m" } }))).toBe("idle");
    expect(formatTmuxPaneState(pane("%1", "main", { status: { kind: "done", title: "Done 3m" } }))).toBe("done");
    expect(formatTmuxPaneState(pane("%1", "main", { status: { kind: "blocked", title: "Needs permission" } }))).toBe("needs permission");
    expect(formatTmuxPaneState(pane("%1", "main", { status: { kind: "unknown", title: "Unknown" } }))).toBe("");
    expect(formatTmuxPaneState(pane("%1", "main"))).toBe("");
  });

  it("ends the sub-line with the state and the agent's last reply, both hidden in zen mode", () => {
    const nowMs = new Date(2026, 9, 20, 12, 0).getTime();
    const entries = [
      pane("%1", "main", {
        displayName: "build agent",
        windowIndex: 5,
        paneIndex: 0,
        lastInputAtMs: nowMs - 3 * 60 * 60_000,
        status: { kind: "blocked", title: "Asking a question" },
        lastSaid: "Should I push to the fork?"
      })
    ];
    const props = { groupPreferences: [], paneViews: allSeen, panes: entries, pinnedNames: [], selected: "%1", nowMs, onSelect: vi.fn(), onToggleGroup: vi.fn() };
    const separator = '<span aria-hidden="true" class="tmux-session-sub-separator">·</span>';
    const target = '<span class="tmux-session-sub-session">main</span><span class="tmux-session-sub-window">:5</span>';
    const time = '<span class="tmux-session-last-prompt">3h ago</span>';

    const html = renderToStaticMarkup(<TmuxSessionList {...props} />);
    expect(html).toContain(`<span class="tmux-session-sub">${target}${separator}${time}${separator}<span class="tmux-session-sub-state">asking a question</span>${separator}<span class="tmux-session-sub-said">Should I push to the fork?</span></span>`);
    expect(html).toMatch(/title="build agent \([^"]*, last said: Should I push to the fork\?/);

    const zen = renderToStaticMarkup(<TmuxSessionList {...props} showState={false} />);
    expect(zen).toContain(`<span class="tmux-session-sub">${target}${separator}${time}</span>`);
    expect(zen).not.toContain("tmux-session-sub-state");
    expect(zen).not.toContain("Should I push");
  });
});
