import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { normalizeWindowSnoozeInput, WindowSnoozeSheet } from "../WindowSnoozeSheet.js";

describe("WindowSnoozeSheet", () => {
  it("offers the presets and a custom duration, with Wake now only for a snoozed window", () => {
    const html = renderToStaticMarkup(
      <WindowSnoozeSheet paneName="build agent" snooze={vi.fn()} wake={vi.fn()} onClose={vi.fn()} />
    );
    expect(html).toContain('aria-label="Snooze window"');
    for (const label of ["1 hour", "3 hours", "Tomorrow", "3 days", "1 week"]) {
      expect(html).toContain(`>${label}</button>`);
    }
    expect(html).toContain("Custom: 45m, 6h, 2d, 2w");
    expect(html).not.toContain("Wake now");

    const nowMs = new Date(2026, 9, 4, 14, 0).getTime();
    const snoozed = renderToStaticMarkup(
      <WindowSnoozeSheet nowMs={nowMs} paneName="build agent" snoozedUntilMs={nowMs + 25 * 60_000} snooze={vi.fn()} wake={vi.fn()} onClose={vi.fn()} />
    );
    expect(snoozed).toContain("build agent · wakes 25m");
    expect(snoozed).toContain("Wake now");
  });

  it("normalizes typed durations before validating them", () => {
    expect(normalizeWindowSnoozeInput(" 3H ")).toBe("3h");
    expect(normalizeWindowSnoozeInput("2d")).toBe("2d");
  });
});
