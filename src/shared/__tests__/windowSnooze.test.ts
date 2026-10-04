import { describe, expect, it } from "vitest";

import { formatWindowWake, isValidWindowSnoozeDuration, WINDOW_SNOOZE_PRESETS } from "../windowSnooze.js";

describe("window snooze durations", () => {
  it("accepts tmux-hide-window's 30m, 3h, 10d, 2w forms", () => {
    for (const duration of ["30m", "3h", "1d", "10d", "2w", "3650d", "0001h"]) {
      expect(isValidWindowSnoozeDuration(duration), duration).toBe(true);
    }
  });

  it("rejects bare numbers, zero, too long, other units, and anything shell-like", () => {
    for (const duration of ["", "3", "0h", "3651d", "12345m", "3H", " 3h", "3h ", "3s", "1.5h", "-1d", "3h;id", "$(id)", 3, null, undefined]) {
      expect(isValidWindowSnoozeDuration(duration), String(duration)).toBe(false);
    }
  });

  it("offers valid presets in order", () => {
    expect(WINDOW_SNOOZE_PRESETS.map((preset) => preset.duration)).toEqual(["1h", "3h", "1d", "3d", "1w"]);
    expect(WINDOW_SNOOZE_PRESETS.every((preset) => isValidWindowSnoozeDuration(preset.duration))).toBe(true);
  });
});

describe("window wake times", () => {
  const now = new Date(2026, 9, 4, 14, 0).getTime();
  const minutes = (count: number) => now + count * 60_000;

  it("counts down within a day", () => {
    expect(formatWindowWake(minutes(-5), now)).toBe("wakes now");
    expect(formatWindowWake(minutes(1), now)).toBe("wakes now");
    expect(formatWindowWake(minutes(25), now)).toBe("wakes 25m");
    expect(formatWindowWake(minutes(180), now)).toBe("wakes 3h");
    expect(formatWindowWake(minutes(23 * 60), now)).toBe("wakes 23h");
  });

  it("names the weekday within a week, then the date", () => {
    expect(formatWindowWake(new Date(2026, 9, 6, 9, 0).getTime(), now)).toBe("wakes Tue 9:00");
    expect(formatWindowWake(new Date(2026, 9, 5, 14, 5).getTime(), now)).toBe("wakes Mon 14:05");
    expect(formatWindowWake(new Date(2026, 9, 12, 9, 0).getTime(), now)).toBe("wakes Oct 12");
  });
});
