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
});
