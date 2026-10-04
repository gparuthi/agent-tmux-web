// Snooze presets for the pane's window, in tmux-hide-window's duration syntax.
export const WINDOW_SNOOZE_PRESETS: ReadonlyArray<{ duration: string; label: string }> = [
  { duration: "1h", label: "1 hour" },
  { duration: "3h", label: "3 hours" },
  { duration: "1d", label: "Tomorrow" },
  { duration: "3d", label: "3 days" },
  { duration: "1w", label: "1 week" }
];

export const WINDOW_SNOOZE_DURATION_PATTERN = /^\d{1,4}[mhdw]$/;

// tmux-hide-window's parseSnooze also rejects 0 and anything over 3650 units.
export function isValidWindowSnoozeDuration(value: unknown): value is string {
  return typeof value === "string"
    && WINDOW_SNOOZE_DURATION_PATTERN.test(value)
    && Number(value.slice(0, -1)) >= 1
    && Number(value.slice(0, -1)) <= 3650;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// "wakes 25m" / "wakes 3h" within a day, "wakes Tue 9:00" within a week, else "wakes Oct 12".
export function formatWindowWake(untilMs: number, nowMs: number): string {
  const remainingMs = untilMs - nowMs;
  if (remainingMs <= 60_000) {
    return "wakes now";
  }
  if (remainingMs < 60 * 60_000) {
    return `wakes ${Math.round(remainingMs / 60_000)}m`;
  }
  if (remainingMs < 23.5 * 60 * 60_000) {
    return `wakes ${Math.round(remainingMs / (60 * 60_000))}h`;
  }
  const at = new Date(untilMs);
  if (remainingMs < 7 * 24 * 60 * 60_000) {
    return `wakes ${WEEKDAYS[at.getDay()]} ${at.getHours()}:${String(at.getMinutes()).padStart(2, "0")}`;
  }
  return `wakes ${MONTHS[at.getMonth()]} ${at.getDate()}`;
}
