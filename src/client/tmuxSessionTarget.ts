import type { TmuxSessionDto } from "../shared/api.js";

export const TMUX_SESSION_QUERY_PARAM = "tmuxSession";
export const PINNED_TMUX_SESSIONS_STORAGE_KEY = "agent-tmux-web.pinned-sessions";

export function readRequestedTmuxSession(search: string): string {
  const params = new URLSearchParams(search);
  return normalizeRequestedTmuxSession(params.get(TMUX_SESSION_QUERY_PARAM));
}

export function normalizeRequestedTmuxSession(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function removeRequestedTmuxSession(url: URL): string {
  url.searchParams.delete(TMUX_SESSION_QUERY_PARAM);
  return url.toString();
}

export function parsePinnedTmuxSessionNames(serialized: string | null): string[] {
  if (!serialized) {
    return [];
  }
  try {
    const value: unknown = JSON.parse(serialized);
    if (!Array.isArray(value)) {
      return [];
    }
    return [...new Set(value
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => entry.trim())
      .filter(Boolean))];
  } catch {
    return [];
  }
}

export function togglePinnedTmuxSessionName(pinnedSessionNames: string[], sessionName: string): string[] {
  return pinnedSessionNames.includes(sessionName)
    ? pinnedSessionNames.filter((name) => name !== sessionName)
    : [...pinnedSessionNames, sessionName];
}

export function orderTmuxSessionsByPins(sessions: TmuxSessionDto[], pinnedSessionNames: string[]): TmuxSessionDto[] {
  const pinnedNames = new Set(pinnedSessionNames);
  return sessions
    .map((session, index) => ({ session, index }))
    .sort((left, right) => Number(pinnedNames.has(right.session.name)) - Number(pinnedNames.has(left.session.name)) || left.index - right.index)
    .map(({ session }) => session);
}

export function tmuxPaneShortName(entry: TmuxSessionDto): string {
  return entry.session !== undefined && entry.windowIndex !== undefined && entry.paneIndex !== undefined
    ? `${entry.session}:${entry.windowIndex}.${entry.paneIndex}`
    : entry.name;
}

export function tmuxPaneDisplayName(entry: TmuxSessionDto): string {
  return entry.label ?? entry.name;
}

// Rows sit under a session header, so drop the repeated "session:" prefix from the label.
export function tmuxPaneRowLabel(entry: TmuxSessionDto): string {
  const label = tmuxPaneDisplayName(entry);
  return entry.session && label.startsWith(`${entry.session}:`) ? label.slice(entry.session.length + 1) : label;
}

export function findTmuxPane(entries: TmuxSessionDto[], target: string): TmuxSessionDto | undefined {
  return entries.find((entry) => entry.name === target);
}

export function findTmuxPaneForSession(entries: TmuxSessionDto[], session: string): TmuxSessionDto | undefined {
  const panes = entries.filter((entry) => (entry.session ?? entry.name) === session);
  return panes.find((entry) => entry.windowActive && entry.paneActive) ?? panes[0];
}

export function defaultTmuxPaneSelection(entries: TmuxSessionDto[]): string {
  const attached = entries.filter((entry) => entry.attached);
  return (attached.find((entry) => entry.windowActive && entry.paneActive) ?? attached[0] ?? entries[0])?.name ?? "";
}

export function tmuxSessionGroupHeader(entries: TmuxSessionDto[], index: number): string | null {
  const session = entries[index]?.session;
  if (!session) {
    return null;
  }
  return index === 0 || entries[index - 1]?.session !== session ? session : null;
}

// Status messages are built from pane targets; show readable pane names instead of "%12".
export function formatTmuxStatusText(text: string, entries: TmuxSessionDto[]): string {
  const byTarget = new Map(entries.filter((entry) => entry.paneId).map((entry) => [entry.name, tmuxPaneShortName(entry)]));
  if (byTarget.size === 0) {
    return text;
  }
  return text.replace(/(^|\s)(\S*%\d+)(?=$|[\s;:,.)])/g, (match, lead: string, target: string) => {
    const name = byTarget.get(target);
    return name ? `${lead}${name}` : match;
  });
}
