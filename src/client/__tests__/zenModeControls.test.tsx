import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { TmuxSessionDto } from "../../shared/api.js";
import { TmuxSessionList } from "../TmuxSessionList.js";
import { ZenChip, ZenNextButton } from "../ZenModeControls.js";
import { filterZenPanes } from "../zenMode.js";

const NOW = Date.parse("2026-10-22T12:00:00Z");

const pane = (name: string, displayName: string, lastInputAtMs: number): TmuxSessionDto => ({
  name,
  session: "main",
  displayName,
  windows: 1,
  created: "2026-10-01T00:00:00.000Z",
  attached: false,
  lastInputAtMs
});

const panes = [pane("%1", "fresh agent", NOW - 1000), pane("%2", "week old agent", NOW - 7 * 24 * 60 * 60_000), pane("%3", "month old agent", NOW - 30 * 24 * 60 * 60_000)];

function renderList(zenHiddenCount: number, onExitZen = vi.fn()) {
  const visible = zenHiddenCount > 0 ? filterZenPanes(panes, "%1", NOW) : panes;
  return renderToStaticMarkup(
    <TmuxSessionList
      groupPreferences={[]}
      paneViews={{ baselineMs: Number.MAX_SAFE_INTEGER, viewed: [] }}
      panes={visible}
      pinnedNames={[]}
      selected="%1"
      zenHiddenCount={zenHiddenCount}
      onExitZen={onExitZen}
      onSelect={vi.fn()}
     
      onToggleGroup={vi.fn()}
    />
  );
}

describe("zen mode in the session list", () => {
  it("lists only active panes and shows how many are hidden", () => {
    const html = renderList(2);

    expect(html).toContain("fresh agent");
    expect(html).not.toContain("week old agent");
    expect(html).not.toContain("month old agent");
    expect(html).toContain("2 hidden by zen mode");
    expect(html).toContain("Show all");
  });

  it("shows no footer when nothing is hidden", () => {
    const html = renderList(0);

    expect(html).toContain("week old agent");
    expect(html).not.toContain("hidden by zen mode");
  });
});

describe("ZenNextButton", () => {
  it("is a labelled, enabled button when another pane is active", () => {
    const html = renderToStaticMarkup(<ZenNextButton next="%2" onSelect={vi.fn()} />);

    expect(html).toContain('aria-label="Next active session"');
    expect(html).not.toContain("disabled");
  });

  it("is disabled with an explanatory tooltip when no other pane is active", () => {
    const html = renderToStaticMarkup(<ZenNextButton next="" onSelect={vi.fn()} />);

    expect(html).toContain("disabled");
    expect(html).toContain('title="No other active session"');
  });
});

describe("ZenChip", () => {
  it("renders a tappable Zen indicator", () => {
    const html = renderToStaticMarkup(<ZenChip onExit={vi.fn()} />);

    expect(html).toContain("Zen");
    expect(html).toContain("<button");
  });
});
