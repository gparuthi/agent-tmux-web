import type { TmuxSessionDto } from "../shared/api.js";
import { groupTmuxPanes } from "./tmuxSessionGroups.js";

export const ZEN_MODE_STORAGE_KEY = "agent-tmux-web.zen-mode";

// Zen keeps panes the owner prompted within a day, plus any pane that is working right now.
export const ZEN_ACTIVE_WITHIN_MS = 24 * 60 * 60_000;

export function parseZenMode(stored: string | null): boolean {
  return stored === "1";
}

export function serializeZenMode(on: boolean): string {
  return on ? "1" : "0";
}

// Snoozed panes are parked on purpose, so they stay out even while busy.
export function isZenActivePane(pane: TmuxSessionDto, nowMs: number): boolean {
  if (pane.snoozedUntilMs) {
    return false;
  }
  if (pane.status?.kind === "working") {
    return true;
  }
  return pane.lastInputAtMs !== undefined && nowMs - pane.lastInputAtMs <= ZEN_ACTIVE_WITHIN_MS;
}

// The selected pane stays until the owner navigates away, like the agent filter.
export function filterZenPanes(panes: TmuxSessionDto[], selected: string, nowMs: number): TmuxSessionDto[] {
  return panes.filter((pane) => pane.name === selected || isZenActivePane(pane, nowMs));
}

// Rail order (pinned, then each session group), including panes in collapsed groups.
function railOrderNames(panes: TmuxSessionDto[], pinnedNames: string[]): string[] {
  const { pinned, groups } = groupTmuxPanes(panes, pinnedNames);
  return [...pinned, ...groups.flatMap((group) => group.panes)].map((pane) => pane.name);
}

// The next active pane after `selected` in rail order, wrapping around; "" when no other pane is active.
export function nextZenPane(panes: TmuxSessionDto[], pinnedNames: string[], selected: string, nowMs: number): string {
  const order = railOrderNames(panes, pinnedNames);
  const active = new Set(panes.filter((pane) => isZenActivePane(pane, nowMs)).map((pane) => pane.name));
  const start = order.indexOf(selected);
  for (let step = 1; step <= order.length; step += 1) {
    const name = order[(start + step + order.length) % order.length];
    if (name !== selected && active.has(name)) {
      return name;
    }
  }
  return "";
}
