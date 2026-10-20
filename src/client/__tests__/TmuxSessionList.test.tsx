import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { TmuxSessionDto } from "../../shared/api.js";
import { TmuxSessionList } from "../TmuxSessionList.js";
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
      onTogglePin={vi.fn()}
      onToggleGroup={vi.fn()}
    />
  );
}

describe("TmuxSessionList", () => {
  it("nests panes under expandable session headers and collapses underscore sessions", () => {
    const html = render("%1");

    expect(html).toContain('aria-expanded="true" aria-label="main, 1 pane"');
    expect(html).toContain('aria-expanded="true" aria-label="gp, 1 pane"');
    expect(html).toContain('aria-expanded="false" aria-label="_hidden, 2 panes, Needs permission"');
    expect(html).toContain("build agent");
    expect(html).not.toContain("worker");
    expect(html).toContain('class="tmux-session-status-dot blocked"');
    expect(html).toContain('<span class="tmux-session-detail">0.0 · zsh · ~/work</span>');
  });

  it("marks a collapsed group that holds the selected pane without expanding it", () => {
    const html = render("%4");

    expect(html).toContain("tmux-session-group-header contains-active");
    expect(html).toContain("_hidden, 2 panes, Needs permission, selected pane inside");
    expect(html).not.toContain("worker");
  });

  it("follows stored expansion choices", () => {
    const html = render("%2", [], [["_hidden", false], ["main", true]]);

    expect(html).toContain('aria-expanded="true" aria-label="_hidden, 2 panes"');
    expect(html).toContain("worker");
    expect(html).toContain('aria-expanded="false" aria-label="main, 1 pane, Working"');
    expect(html).not.toContain("build agent");
  });

  it("lists pinned panes once, in a Pinned section above the groups", () => {
    const html = render("%1", ["%4"]);

    expect(html.indexOf("Pinned")).toBeLessThan(html.indexOf("main, 1 pane"));
    expect(html.match(/>worker</g)).toHaveLength(1);
    expect(html).toContain('aria-label="Unpin worker"');
    expect(html).toContain('<span class="tmux-session-detail">_hidden:0.0 · zsh · ~/work</span>');
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
    expect(html).toContain('aria-label="gp, 1 pane"');
    expect(html).toContain('aria-label="_hidden, 1 pane, Unknown, new output"');
    expect(html).toMatch(/tmux-session-group-header +unseen/);
    expect(html).not.toContain('aria-label="main, 1 pane, new output"');
  });

  it("shows a snoozed pane's wake time and a Wake button only when waking is available", () => {
    const nowMs = new Date(2026, 9, 4, 14, 0).getTime();
    const entries = [
      pane("%1", "main", { displayName: "build agent" }),
      pane("%8", "_hidden", { displayName: "camera eval", snoozedUntilMs: nowMs + 3 * 60 * 60_000 })
    ];
    const onWake = vi.fn();
    const props = { groupPreferences: [["_hidden", false]] as TmuxSessionGroupPreferences, paneViews: allSeen, panes: entries, pinnedNames: [], selected: "%1", onSelect: vi.fn(), onTogglePin: vi.fn(), onToggleGroup: vi.fn(), nowMs };
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
      <TmuxSessionList groupPreferences={[]} paneViews={allSeen} panes={entries} pinnedNames={[]} selected="%1" nowMs={nowMs} onSelect={vi.fn()} onTogglePin={vi.fn()} onToggleGroup={vi.fn()} />
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
});
