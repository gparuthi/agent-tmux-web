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
  // null is the flat, headerless list of every pane outside a "_" session.
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

const isUnderscoreTmuxSession = (entry: TmuxSessionDto) => (entry.session ?? "").startsWith("_");

// A session's last owner input is its newest pane's; 0 when no pane has one.
export function tmuxGroupLastInputAtMs(panes: TmuxSessionDto[]): number {
  return Math.max(0, ...panes.map((pane) => pane.lastInputAtMs ?? 0));
}

// Newest owner input first; Array.prototype.sort is stable, so ties keep server order.
function byLastInput<T>(items: T[], inputAtMs: (item: T) => number): T[] {
  return [...items].sort((left, right) => inputAtMs(right) - inputAtMs(left));
}

// One flat list, newest owner input first and undated panes last in server order; pinned panes float
// above it. Only "_" sessions (_hidden, where snoozed windows park) keep a collapsible group, after it.
export function groupTmuxPanes(entries: TmuxSessionDto[], pinnedNames: string[]): GroupedTmuxPanes {
  const pinnedSet = new Set(pinnedNames);
  const pinned: TmuxSessionDto[] = [];
  const flat: TmuxSessionDto[] = [];
  const parked: TmuxSessionGroup[] = [];
  const bySession = new Map<string, TmuxSessionGroup>();
  for (const entry of entries) {
    if (pinnedSet.has(entry.name)) {
      pinned.push(entry);
    } else if (isUnderscoreTmuxSession(entry)) {
      const session = entry.session ?? "";
      let group = bySession.get(session);
      if (!group) {
        group = { session, panes: [] };
        bySession.set(session, group);
        parked.push(group);
      }
      group.panes.push(entry);
    } else {
      flat.push(entry);
    }
  }
  const byPaneInput = (panes: TmuxSessionDto[]) => byLastInput(panes, (pane) => pane.lastInputAtMs ?? 0);
  const groups = parked.map((group) => ({ ...group, panes: byPaneInput(group.panes) }));
  return {
    pinned: byPaneInput(pinned),
    groups: [
      ...(flat.length > 0 ? [{ session: null, panes: byPaneInput(flat) }] : []),
      ...byLastInput(groups, (group) => tmuxGroupLastInputAtMs(group.panes))
    ]
  };
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

export const TMUX_RAIL_SHORTCUT_COUNT = 9;

// Keys 1-9 address the rail's first nine rows as shown: pinned, then expanded groups; rows in
// collapsed groups and panes the agent filter hides take no number.
export function tmuxRailShortcutPanes(
  railPanes: TmuxSessionDto[],
  pinnedNames: string[],
  preferences: TmuxSessionGroupPreferences
): string[] {
  return visibleTmuxRailPanes(railPanes, pinnedNames, preferences)
    .slice(0, TMUX_RAIL_SHORTCUT_COUNT)
    .map((entry) => entry.name);
}

// The pane a digit (1-9) selects, or "" when the rail has fewer rows.
export function tmuxRailPaneForDigit(
  railPanes: TmuxSessionDto[],
  pinnedNames: string[],
  preferences: TmuxSessionGroupPreferences,
  digit: number
): string {
  if (!Number.isInteger(digit) || digit < 1 || digit > TMUX_RAIL_SHORTCUT_COUNT) {
    return "";
  }
  return tmuxRailShortcutPanes(railPanes, pinnedNames, preferences)[digit - 1] ?? "";
}

export type TmuxRailView = {
  pinnedNames: string[];
  preferences: TmuxSessionGroupPreferences;
  showAll: boolean;
};

// The rows a selection may fall back to: the rail's own rows in display order, minus "_" sessions
// (_hidden) and snoozed panes, whether or not the owner expanded them.
function fallbackTmuxRailPanes(entries: TmuxSessionDto[], view: TmuxRailView): TmuxSessionDto[] {
  return visibleTmuxRailPanes(filterTmuxAgentPanes(entries, view.showAll, ""), view.pinnedNames, view.preferences)
    .filter((entry) => !isUnderscoreTmuxSession(entry) && !entry.snoozedUntilMs);
}

// The pane to open on load: the last one this browser selected while tmux still lists it, even a
// non-agent pane or one in a collapsed group, else the rail's first row. A snoozed pane, or one in a
// "_" session (_hidden) the owner has not expanded, falls back instead.
export function initialTmuxPaneSelection(entries: TmuxSessionDto[], stored: string | null, view: TmuxRailView): string {
  const expanded = (session: string | undefined) => view.preferences.some(([name, collapsed]) => name === session && !collapsed);
  const restored = stored ? entries.find((entry) => entry.name === stored) : undefined;
  if (restored && !restored.snoozedUntilMs && (!isUnderscoreTmuxSession(restored) || expanded(restored.session))) {
    return restored.name;
  }
  return fallbackTmuxPaneSelection(entries, view);
}

// A selection made before the first listing arrived (a ?tmuxSession= deep link) wins over the stored pane.
export function tmuxPaneSelectionOnLoad(current: string, entries: TmuxSessionDto[], stored: string | null, view: TmuxRailView): string {
  return current || initialTmuxPaneSelection(entries, stored, view);
}

// The rail's first row a selection may land on, or nothing.
export function fallbackTmuxPaneSelection(entries: TmuxSessionDto[], view: TmuxRailView): string {
  return fallbackTmuxRailPanes(entries, view)[0]?.name ?? "";
}

// After the selected pane left (closed, or its window snoozed): the next rail row of before that the
// rail still shows, else the one before it, else the rail's first row. Never a "_" session or a
// snoozed pane, and only rows the agent filter and collapsed groups leave visible.
export function nextTmuxRailPaneAfter(before: TmuxSessionDto[], removed: string, entries: TmuxSessionDto[], view: TmuxRailView): string {
  const eligible = fallbackTmuxRailPanes(entries, view).filter((entry) => entry.name !== removed);
  const names = new Set(eligible.map((entry) => entry.name));
  const index = before.findIndex((entry) => entry.name === removed);
  const candidates = index < 0 ? [] : [...before.slice(index + 1), ...before.slice(0, index).reverse()];
  return candidates.find((entry) => names.has(entry.name))?.name ?? eligible[0]?.name ?? "";
}

// A list refresh that dropped the selected pane (closed from a terminal or a tpal action) picks the
// pane after it; null keeps the selection, including one the previous list never had (a deep link).
export function tmuxSelectionAfterListChange(
  previous: TmuxSessionDto[],
  entries: TmuxSessionDto[],
  selected: string,
  view: TmuxRailView
): string | null {
  if (!selected || entries.some((entry) => entry.name === selected) || !previous.some((entry) => entry.name === selected)) {
    return null;
  }
  const before = visibleTmuxRailPanes(filterTmuxAgentPanes(previous, view.showAll, selected), view.pinnedNames, view.preferences);
  return nextTmuxRailPaneAfter(before, selected, entries, view);
}

// The most attention-worthy status wins: blocked, working, done, idle, then unknown; ties keep pane order.
export function aggregateTmuxSessionStatus(panes: TmuxSessionDto[]): TmuxSessionStatusDto {
  return panes.map(tmuxPaneStatus).reduce<TmuxSessionStatusDto | null>(
    (best, status) => !best || STATUS_ATTENTION_RANK[status.kind] > STATUS_ATTENTION_RANK[best.kind] ? status : best,
    null
  ) ?? UNKNOWN_STATUS;
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
