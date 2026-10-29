import { ChevronRight, Eye, Pin, Sunrise } from "lucide-react";
import { Fragment, type ReactNode } from "react";

import type { TmuxSessionDto } from "../shared/api.js";
import { TMUX_STATUS_TITLES } from "../shared/tmuxStatus.js";
import { formatWindowWake } from "../shared/windowSnooze.js";
import {
  aggregateTmuxSessionStatus,
  groupTmuxPanes,
  hasUnseenTmuxActivity,
  isTmuxSessionGroupCollapsed,
  tmuxGroupLastInputAtMs,
  tmuxPaneStatus,
  tmuxRailShortcutPanes,
  type TmuxPaneViews,
  type TmuxSessionGroupPreferences
} from "./tmuxSessionGroups.js";
import { tmuxPaneDetail, tmuxPaneDisplayName } from "./tmuxSessionTarget.js";

export const TMUX_PANE_STALE_AFTER_MS = 3 * 24 * 60 * 60_000;

// "5d idle" when the owner's last input is over three days old; snoozed panes are parked on purpose.
export function formatTmuxPaneStale(pane: TmuxSessionDto, nowMs: number): string {
  if (pane.snoozedUntilMs || !pane.lastInputAtMs) {
    return "";
  }
  const idleMs = nowMs - pane.lastInputAtMs;
  return idleMs > TMUX_PANE_STALE_AFTER_MS ? `${Math.floor(idleMs / (24 * 60 * 60_000))}d idle` : "";
}

// "just now", "5m ago", "3h ago", "2d ago"; "" when no prompt is known.
export function formatTmuxLastPrompt(atMs: number | undefined, nowMs: number): string {
  if (!atMs) {
    return "";
  }
  const minutes = Math.floor((nowMs - atMs) / 60_000);
  if (minutes < 1) {
    return "just now";
  }
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
}

// The tmux target after "session:", like the status bar: "5", or "5.1" for a split window's second pane.
export function tmuxPaneWindowTarget(pane: TmuxSessionDto): string {
  if (pane.windowIndex === undefined) {
    return "";
  }
  return pane.paneIndex ? `${pane.windowIndex}.${pane.paneIndex}` : String(pane.windowIndex);
}

// The status dot's state as a word ("working", "idle", "needs permission"); blocked keeps its reason.
export function formatTmuxPaneState(pane: TmuxSessionDto): string {
  const status = pane.status;
  if (!status || status.kind === "unknown") {
    return "";
  }
  const word = status.kind === "blocked" ? status.title : TMUX_STATUS_TITLES[status.kind];
  return word.charAt(0).toLowerCase() + word.slice(1);
}

type TmuxSessionListProps = {
  panes: TmuxSessionDto[];
  pinnedNames: string[];
  selected: string;
  groupPreferences: TmuxSessionGroupPreferences;
  paneViews: TmuxPaneViews;
  onSelect: (name: string) => void;
  onToggleGroup: (session: string, collapsed: boolean) => void;
  // Present when tmux-hide-window is installed; snoozed rows then get a Wake button.
  onWake?: (name: string) => void;
  // Panes zen mode filtered out of `panes`; the footer offers to turn zen off.
  zenHiddenCount?: number;
  onExitZen?: () => void;
  // Zen mode turns this off: the sub-line keeps the target and time but drops the state and last reply.
  showState?: boolean;
  nowMs?: number;
};

export function TmuxSessionList({
  panes,
  pinnedNames,
  selected,
  groupPreferences,
  paneViews,
  onSelect,
  onToggleGroup,
  onWake,
  zenHiddenCount = 0,
  onExitZen,
  showState = true,
  nowMs = Date.now()
}: TmuxSessionListProps) {
  const { pinned, groups } = groupTmuxPanes(panes, pinnedNames);
  const unseen = (pane: TmuxSessionDto) => pane.name !== selected && hasUnseenTmuxActivity(paneViews, pane);
  const shortcuts = new Map(tmuxRailShortcutPanes(panes, pinnedNames, groupPreferences).map((name, index) => [name, index + 1]));

  function renderPane(pane: TmuxSessionDto) {
    const status = tmuxPaneStatus(pane);
    const viewerCount = pane.viewerCount ?? 0;
    const displayName = tmuxPaneDisplayName(pane);
    const wake = pane.snoozedUntilMs ? formatWindowWake(pane.snoozedUntilMs, nowMs) : "";
    const stale = formatTmuxPaneStale(pane, nowMs);
    const lastPrompt = formatTmuxLastPrompt(pane.lastInputAtMs, nowMs);
    const window = tmuxPaneWindowTarget(pane);
    const state = showState ? formatTmuxPaneState(pane) : "";
    const said = showState ? pane.lastSaid ?? "" : "";
    const subParts: Array<[string, ReactNode]> = [
      ...(pane.session ? [["target", <>
        <span className="tmux-session-sub-session">{pane.session}</span>
        {window && <span className="tmux-session-sub-window">:{window}</span>}
      </>] as [string, ReactNode]] : []),
      ...(lastPrompt ? [["time", <span className="tmux-session-last-prompt">{lastPrompt}</span>] as [string, ReactNode]] : []),
      ...(state ? [["state", <span className="tmux-session-sub-state">{state}</span>] as [string, ReactNode]] : []),
      ...(said ? [["said", <span className="tmux-session-sub-said">{said}</span>] as [string, ReactNode]] : [])
    ];
    const shortcut = shortcuts.get(pane.name);
    return (
      <div className={`tmux-session-row ${selected === pane.name ? "active" : ""} ${unseen(pane) ? "unseen" : ""}${wake && onWake ? " snoozed" : ""}${stale ? " stale" : ""}`} key={pane.name}>
        <button
          aria-current={selected === pane.name ? "true" : undefined}
          aria-keyshortcuts={shortcut ? `${shortcut} Alt+${shortcut}` : undefined}
          className="tmux-session-select"
          title={`${displayName} (${tmuxPaneDetail(pane)}): ${status.title}${wake ? `, snoozed, ${wake}` : ""}${stale ? `, possibly stale, ${stale}` : ""}${lastPrompt ? `, last prompt ${lastPrompt}` : ""}${said ? `, last said: ${said}` : ""}${unseen(pane) ? ", new output" : ""}${viewerCount > 0 ? `, ${viewerCount} other ${viewerCount === 1 ? "viewer" : "viewers"}` : ""}`}
          type="button"
          onClick={() => onSelect(pane.name)}
        >
          <span
            aria-label={`${status.title} status`}
            className={`tmux-session-status-dot ${status.kind}`}
            title={status.title}
          />
          <span className="tmux-session-title">
            <span className="tmux-session-name">{displayName}</span>
            {subParts.length > 0 && (
              <span className="tmux-session-sub">
                {subParts.map(([key, node], index) => (
                  <Fragment key={key}>
                    {index > 0 && <span aria-hidden="true" className="tmux-session-sub-separator">·</span>}
                    {node}
                  </Fragment>
                ))}
              </span>
            )}
          </span>
          {wake && <span className="tmux-session-wake">{wake}</span>}
          {stale && <span className="tmux-session-stale">{stale}</span>}
          {viewerCount > 0 && (
            <span className="tmux-session-viewers" title={`${viewerCount} other tmux ${viewerCount === 1 ? "client" : "clients"} viewing`}>
              <Eye aria-hidden="true" size={13} />
              {viewerCount > 1 && <span>{viewerCount}</span>}
            </span>
          )}
          {shortcut && <span aria-hidden="true" className="tmux-session-shortcut">{shortcut}</span>}
        </button>
        {wake && onWake && (
          <button
            aria-label={`Wake ${displayName} now`}
            className="tmux-session-wake-button"
            title="Wake now: move the window back to its session"
            type="button"
            onClick={() => onWake(pane.name)}
          >
            <Sunrise aria-hidden="true" size={12} />
            <span>Wake</span>
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="tmux-sessions">
      {pinned.length > 0 && (
        <div aria-label="Pinned panes" className="tmux-session-group" role="group">
          <div className="tmux-session-group-title">
            <Pin aria-hidden="true" size={11} />
            <span>Pinned</span>
          </div>
          {pinned.map((pane) => renderPane(pane))}
        </div>
      )}
      {groups.map((group, index) => {
        if (group.session === null) {
          return (
            <div className="tmux-session-group" key="ungrouped">
              {group.panes.map((pane) => renderPane(pane))}
            </div>
          );
        }
        const session = group.session;
        const collapsed = isTmuxSessionGroupCollapsed(groupPreferences, session);
        const containsSelected = group.panes.some((pane) => pane.name === selected);
        const groupUnseen = group.panes.some(unseen);
        const aggregate = aggregateTmuxSessionStatus(group.panes);
        const groupLastPrompt = collapsed ? formatTmuxLastPrompt(tmuxGroupLastInputAtMs(group.panes), nowMs) : "";
        const panesId = `tmux-session-group-${index}`;
        const paneCount = `${group.panes.length} ${group.panes.length === 1 ? "pane" : "panes"}`;
        const summary = `${session}, ${paneCount}${collapsed ? `, ${aggregate.title}` : ""}${groupLastPrompt ? `, last prompt ${groupLastPrompt}` : ""}${groupUnseen ? ", new output" : ""}${collapsed && containsSelected ? ", selected pane inside" : ""}`;
        return (
          <div aria-label={`tmux session ${session}`} className="tmux-session-group" key={`session:${session}`} role="group">
            <button
              aria-controls={collapsed ? undefined : panesId}
              aria-expanded={!collapsed}
              aria-label={summary}
              className={`tmux-session-group-header ${collapsed && containsSelected ? "contains-active" : ""} ${groupUnseen ? "unseen" : ""}`}
              title={summary}
              type="button"
              onClick={() => onToggleGroup(session, !collapsed)}
            >
              <ChevronRight aria-hidden="true" className="tmux-session-group-chevron" size={13} />
              <span className="tmux-session-group-name">{session}</span>
              {collapsed && (
                <span aria-hidden="true" className={`tmux-session-status-dot ${aggregate.kind}`} />
              )}
              {groupLastPrompt && <span aria-hidden="true" className="tmux-session-group-time">{groupLastPrompt}</span>}
              <span aria-hidden="true" className="tmux-session-group-count">{group.panes.length}</span>
            </button>
            {!collapsed && (
              <div className="tmux-session-group-panes" id={panesId}>
                {group.panes.map((pane) => renderPane(pane))}
              </div>
            )}
          </div>
        );
      })}
      {zenHiddenCount > 0 && onExitZen && (
        <div className="tmux-zen-footer">
          <span>{zenHiddenCount} hidden by zen mode</span>
          <button type="button" onClick={onExitZen}>Show all</button>
        </div>
      )}
    </div>
  );
}
