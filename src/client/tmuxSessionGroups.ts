import type { TmuxSessionDto, TmuxSessionStatusDto, TmuxSessionStatusKind } from "../shared/api.js";
import { tmuxEntryAgent } from "../shared/tmuxAgents.js";

export const TMUX_SESSION_GROUPS_STORAGE_KEY = "agent-tmux-web.session-groups";
export const MAX_STORED_TMUX_SESSION_GROUPS = 64;
export const TMUX_PANE_VIEWS_STORAGE_KEY = "agent-tmux-web.pane-views";
export const MAX_STORED_TMUX_PANE_VIEWS = 200;
export const SHOW_ALL_TMUX_PANES_STORAGE_KEY = "agent-tmux-web.show-all-panes";
export const LAST_TMUX_PANE_STORAGE_KEY = "agent-tmux-web.last-pane";

// When this browser last looked at each pane; panes never viewed here fall back to baselineMs.
export type TmuxPaneViews = {
  baselineMs: number;
  viewed: Array<[string, number]>;
};

// [tmux session name, collapsed]; only choices that differ from the default, oldest first.
export type TmuxSessionGroupPreferences = Array<[string, boolean]>;

export type TmuxSessionGroup = {
  // null holds legacy rows (and demo rows) that carry no tmux session name.
  session: string | null;
  panes: TmuxSessionDto[];
};

export type GroupedTmuxPanes = {
  pinned: TmuxSessionDto[];
  groups: TmuxSessionGroup[];
};

const UNKNOWN_STATUS: TmuxSessionStatusDto = { kind: "unknown", title: "Unknown" };
const STATUS_ATTENTION_RANK: Record<TmuxSessionStatusKind, number> = { blocked: 4, working: 3, done: 2, idle: 1, unknown: 0 };

export function tmuxPaneStatus(entry: TmuxSessionDto): TmuxSessionStatusDto {
  return entry.status ?? UNKNOWN_STATUS;
}

// Agent panes only, unless showing all; the selected pane stays until the owner navigates away.
export function filterTmuxAgentPanes(entries: TmuxSessionDto[], showAll: boolean, selected: string): TmuxSessionDto[] {
  return showAll ? entries : entries.filter((entry) => entry.name === selected || tmuxEntryAgent(entry) !== null);
}

function lastInputAtMs(panes: TmuxSessionDto[]): number {
  return Math.max(0, ...panes.map((pane) => pane.lastInputAtMs ?? 0));
}

// Newest owner input first; Array.prototype.sort is stable, so ties keep server order.
function byLastInput<T>(items: T[], inputAtMs: (item: T) => number): T[] {
  return [...items].sort((left, right) => inputAtMs(right) - inputAtMs(left));
}

// Pinned panes keep server order and leave their group; groups and their panes sort by last owner input.
export function groupTmuxPanes(entries: TmuxSessionDto[], pinnedNames: string[]): GroupedTmuxPanes {
  const pinnedSet = new Set(pinnedNames);
  const pinned: TmuxSessionDto[] = [];
  const groups: TmuxSessionGroup[] = [];
  const bySession = new Map<string | null, TmuxSessionGroup>();
  for (const entry of entries) {
    const session = entry.session ?? null;
    let group = bySession.get(session);
    if (!group) {
      group = { session, panes: [] };
      bySession.set(session, group);
      groups.push(group);
    }
    if (pinnedSet.has(entry.name)) {
      pinned.push(entry);
    } else {
      group.panes.push(entry);
    }
  }
  const ordered = groups
    .filter((group) => group.panes.length > 0)
    .map((group) => ({ ...group, panes: byLastInput(group.panes, (pane) => pane.lastInputAtMs ?? 0) }));
  return { pinned, groups: byLastInput(ordered, (group) => lastInputAtMs(group.panes)) };
}

// Panes in the order the rail shows them: pinned first, then the panes of expanded groups.
export function visibleTmuxRailPanes(
  entries: TmuxSessionDto[],
  pinnedNames: string[],
  preferences: TmuxSessionGroupPreferences
): TmuxSessionDto[] {
  const { pinned, groups } = groupTmuxPanes(entries, pinnedNames);
  return [
    ...pinned,
    ...groups.flatMap((group) => group.session !== null && isTmuxSessionGroupCollapsed(preferences, group.session) ? [] : group.panes)
  ];
}

export type TmuxRailView = {
  pinnedNames: string[];
  preferences: TmuxSessionGroupPreferences;
  showAll: boolean;
};

// The pane to open on load: the last one this browser selected if the rail still shows it, else the
// rail's first row. "_" sessions (_hidden) only count when the owner expanded them; never by default.
export function initialTmuxPaneSelection(entries: TmuxSessionDto[], stored: string | null, view: TmuxRailView): string {
  const visible = visibleTmuxRailPanes(filterTmuxAgentPanes(entries, view.showAll, ""), view.pinnedNames, view.preferences);
  const underscored = (entry: TmuxSessionDto) => (entry.session ?? "").startsWith("_");
  const expanded = (session: string | undefined) => view.preferences.some(([name, collapsed]) => name === session && !collapsed);
  const restored = stored ? visible.find((entry) => entry.name === stored) : undefined;
  if (restored && (!underscored(restored) || expanded(restored.session))) {
    return restored.name;
  }
  return visible.find((entry) => !underscored(entry))?.name ?? "";
}

// After a pane leaves its place (e.g. its window was snoozed): the next rail row that stayed put,
// else the one before it, else the first visible row that isn't snoozed.
export function nextTmuxRailPaneAfter(before: TmuxSessionDto[], removed: string, after: TmuxSessionDto[]): string {
  const sessions = new Map(after.map((entry) => [entry.name, entry.session]));
  const index = before.findIndex((entry) => entry.name === removed);
  const candidates = index < 0 ? [] : [...before.slice(index + 1), ...before.slice(0, index).reverse()];
  const next = candidates.find((entry) => sessions.has(entry.name) && sessions.get(entry.name) === entry.session && !entry.snoozedUntilMs);
  return next?.name ?? after.find((entry) => entry.name !== removed && !entry.snoozedUntilMs)?.name ?? "";
}

// The most attention-worthy status wins: blocked, working, done, idle, then unknown; ties keep pane order.
export function aggregateTmuxSessionStatus(panes: TmuxSessionDto[]): TmuxSessionStatusDto {
  return panes.map(tmuxPaneStatus).reduce<TmuxSessionStatusDto | null>(
    (best, status) => !best || STATUS_ATTENTION_RANK[status.kind] > STATUS_ATTENTION_RANK[best.kind] ? status : best,
    null
  ) ?? UNKNOWN_STATUS;
}

// Inside a group the "session:" prefix of the pane label is redundant.
export function tmuxPaneGroupDetail(entry: TmuxSessionDto): string {
  const detail = entry.label ?? entry.name;
  const prefix = entry.session ? `${entry.session}:` : "";
  return prefix && detail.startsWith(prefix) ? detail.slice(prefix.length) : detail;
}

export function defaultTmuxSessionGroupCollapsed(session: string): boolean {
  return session.startsWith("_");
}

export function isTmuxSessionGroupCollapsed(preferences: TmuxSessionGroupPreferences, session: string): boolean {
  const stored = preferences.find(([name]) => name === session);
  return stored ? stored[1] : defaultTmuxSessionGroupCollapsed(session);
}

export function setTmuxSessionGroupCollapsed(
  preferences: TmuxSessionGroupPreferences,
  session: string,
  collapsed: boolean
): TmuxSessionGroupPreferences {
  const rest = preferences.filter(([name]) => name !== session);
  const next: TmuxSessionGroupPreferences = collapsed === defaultTmuxSessionGroupCollapsed(session)
    ? rest
    : [...rest, [session, collapsed]];
  return next.slice(-MAX_STORED_TMUX_SESSION_GROUPS);
}

export function parseTmuxSessionGroupPreferences(serialized: string | null): TmuxSessionGroupPreferences {
  if (!serialized) {
    return [];
  }
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    return [];
  }
  if (!Array.isArray(value)) {
    return [];
  }
  let preferences: TmuxSessionGroupPreferences = [];
  for (const entry of value) {
    if (Array.isArray(entry) && typeof entry[0] === "string" && entry[0] && typeof entry[1] === "boolean") {
      preferences = setTmuxSessionGroupCollapsed(preferences, entry[0], entry[1]);
    }
  }
  return preferences;
}

export function parseTmuxPaneViews(serialized: string | null, nowMs: number): TmuxPaneViews {
  let value: unknown = null;
  try {
    value = serialized ? JSON.parse(serialized) : null;
  } catch {
    value = null;
  }
  const record = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const baselineMs = typeof record.baselineMs === "number" && Number.isFinite(record.baselineMs) ? record.baselineMs : nowMs;
  const latest = new Map<string, number>();
  for (const entry of Array.isArray(record.viewed) ? record.viewed : []) {
    if (Array.isArray(entry) && typeof entry[0] === "string" && entry[0] && typeof entry[1] === "number" && Number.isFinite(entry[1])) {
      latest.delete(entry[0]);
      latest.set(entry[0], entry[1]);
    }
  }
  return { baselineMs, viewed: [...latest].slice(-MAX_STORED_TMUX_PANE_VIEWS) };
}

// Records a view at atMs, newest last, capped so vanished panes age out.
export function markTmuxPanesViewed(views: TmuxPaneViews, names: string[], atMs: number): TmuxPaneViews {
  const marked = new Set(names);
  const viewed: Array<[string, number]> = [
    ...views.viewed.filter(([name]) => !marked.has(name)),
    ...[...marked].map((name): [string, number] => [name, atMs])
  ];
  return { baselineMs: views.baselineMs, viewed: viewed.slice(-MAX_STORED_TMUX_PANE_VIEWS) };
}

// Like tmux's monitor-activity flag: output since this browser last viewed the pane.
export function hasUnseenTmuxActivity(views: TmuxPaneViews, pane: TmuxSessionDto): boolean {
  const viewedAtMs = views.viewed.find(([name]) => name === pane.name)?.[1] ?? views.baselineMs;
  return (pane.activityAtMs ?? 0) > viewedAtMs;
}

// window_activity is per tmux window, so viewing one pane marks its window siblings seen too.
export function tmuxWindowPaneNames(entries: TmuxSessionDto[], name: string): string[] {
  const pane = entries.find((entry) => entry.name === name);
  if (!pane) {
    return name ? [name] : [];
  }
  if (pane.session === undefined || pane.windowIndex === undefined) {
    return [pane.name];
  }
  return entries
    .filter((entry) => entry.session === pane.session && entry.windowIndex === pane.windowIndex)
    .map((entry) => entry.name);
}
