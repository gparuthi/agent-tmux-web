import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { ClosedSessionDto } from "../../shared/api.js";
import { ClosedSessionsSection } from "../ClosedSessionsSection.js";
import { TmuxSessionList } from "../TmuxSessionList.js";

const NOW = Date.parse("2026-10-30T12:00:00Z");

const entry = (n: number, extra: Partial<ClosedSessionDto> = {}): ClosedSessionDto => ({
  sessionId: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
  agent: "claude",
  title: `task ${n}`,
  cwd: "/Users/me/work/app",
  cwdLabel: "~/work/app",
  lastPrompt: `prompt ${n}`,
  lastPromptAtMs: NOW - n * 5 * 60_000,
  handoff: true,
  ...extra
});

function render(entries: ClosedSessionDto[], initialExpanded = false) {
  return renderToStaticMarkup(<ClosedSessionsSection entries={entries} initialExpanded={initialExpanded} nowMs={NOW} onReopen={vi.fn()} />);
}

describe("ClosedSessionsSection", () => {
  it("is a collapsed header with the count, and renders nothing when the list is empty", () => {
    const html = render([entry(1), entry(2)]);
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("Recently closed (2)");
    expect(html).not.toContain("task 1");
    expect(render([])).toBe("");
  });

  it("lists title, short cwd, last prompt time, the prompt and both buttons when expanded", () => {
    const html = render([entry(1), entry(2, { handoff: false })], true);
    expect(html).toContain('aria-expanded="true" class="tmux-session-group-header"');
    expect(html).toContain('<span class="tmux-session-name">task 1</span><span class="tmux-session-sub"><span class="tmux-session-sub-session">~/work/app</span><span aria-hidden="true" class="tmux-session-sub-separator">·</span><span class="tmux-session-last-prompt">5m ago</span></span><span class="tmux-session-sub tmux-closed-session-prompt">prompt 1</span>');
    expect(html.match(/>Resume</g)).toHaveLength(2);
    expect(html).toMatch(/aria-label="Start a fresh agent from the handoff of task 1" class="tmux-session-wake-button" title="Start a fresh agent/);
    // No checkpoint: Handoff stays in place but disabled.
    expect(html).toMatch(/aria-label="Start a fresh agent from the handoff of task 2" class="tmux-session-wake-button" disabled="" title="No ctx handoff saved for this session"/);
    expect(html).toContain('title="task 2 (/Users/me/work/app), last prompt 10m ago: prompt 2"');
  });

  it("leaves out the prompt line when there is no prompt", () => {
    const html = render([entry(1, { lastPrompt: "", lastPromptAtMs: NOW - 10_000 })], true);
    expect(html).not.toContain("tmux-closed-session-prompt");
    expect(html).toContain('<span class="tmux-session-last-prompt">just now</span>');
  });

  it("sits at the bottom of the session list", () => {
    const html = renderToStaticMarkup(
      <TmuxSessionList
        groupPreferences={[]}
        paneViews={{ baselineMs: Number.MAX_SAFE_INTEGER, viewed: [] }}
        panes={[{ name: "%1", session: "main", displayName: "live agent", windows: 1, created: "", attached: false }]}
        pinnedNames={[]}
        selected="%1"
        footer={<ClosedSessionsSection entries={[entry(1)]} nowMs={NOW} onReopen={vi.fn()} />}
        onSelect={vi.fn()}
        onToggleGroup={vi.fn()}
      />
    );
    expect(html.indexOf("live agent")).toBeLessThan(html.indexOf("Recently closed (1)"));
    expect(html).toMatch(/Recently closed \(1\)<\/span><\/button><\/div><\/div>$/);
  });
});
