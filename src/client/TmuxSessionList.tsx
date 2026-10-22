import { ChevronRight, Eye, Pin, Sunrise } from "lucide-react";

import type { TmuxSessionDto } from "../shared/api.js";
import { formatWindowWake } from "../shared/windowSnooze.js";
import {
  aggregateTmuxSessionStatus,
  groupTmuxPanes,
  hasUnseenTmuxActivity,
  isTmuxSessionGroupCollapsed,
  tmuxPaneGroupDetail,
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

type TmuxSessionListProps = {
  panes: TmuxSessionDto[];
  pinnedNames: string[];
  selected: string;
  groupPreferences: TmuxSessionGroupPreferences;
  paneViews: TmuxPaneViews;
  onSelect: (name: string) => void;
  onTogglePin: (name: string) => void;
  onToggleGroup: (session: string, collapsed: boolean) => void;
  // Present when tmux-hide-window is installed; snoozed rows then get a Wake button.
  onWake?: (name: string) => void;
  // Panes zen mode filtered out of `panes`; the footer offers to turn zen off.
  zenHiddenCount?: number;
  onExitZen?: () => void;
  nowMs?: number;
};

export function TmuxSessionList({
  panes,
  pinnedNames,
  selected,
  groupPreferences,
  paneViews,
  onSelect,
  onTogglePin,
  onToggleGroup,
  onWake,
  zenHiddenCount = 0,
  onExitZen,
  nowMs = Date.now()
}: TmuxSessionListProps) {
  const { pinned, groups } = groupTmuxPanes(panes, pinnedNames);
  const unseen = (pane: TmuxSessionDto) => pane.name !== selected && hasUnseenTmuxActivity(paneViews, pane);
  const shortcuts = new Map(tmuxRailShortcutPanes(panes, pinnedNames, groupPreferences).map((name, index) => [name, index + 1]));

  function renderPane(pane: TmuxSessionDto, inGroup: boolean) {
    const status = tmuxPaneStatus(pane);
    const isPinned = pinnedNames.includes(pane.name);
    const viewerCount = pane.viewerCount ?? 0;
    const displayName = tmuxPaneDisplayName(pane);
    const wake = pane.snoozedUntilMs ? formatWindowWake(pane.snoozedUntilMs, nowMs) : "";
    const stale = formatTmuxPaneStale(pane, nowMs);
    const shortcut = shortcuts.get(pane.name);
    return (
      <div className={`tmux-session-row ${selected === pane.name ? "active" : ""} ${unseen(pane) ? "unseen" : ""}${wake && onWake ? " snoozed" : ""}${stale ? " stale" : ""}`} key={pane.name}>
        <button
          aria-current={selected === pane.name ? "true" : undefined}
          aria-keyshortcuts={shortcut ? `${shortcut} Alt+${shortcut}` : undefined}
          className="tmux-session-select"
          title={`${displayName} (${tmuxPaneDetail(pane)}): ${status.title}${wake ? `, snoozed, ${wake}` : ""}${stale ? `, possibly stale, ${stale}` : ""}${unseen(pane) ? ", new output" : ""}${viewerCount > 0 ? `, ${viewerCount} other ${viewerCount === 1 ? "viewer" : "viewers"}` : ""}`}
          type="button"
          onClick={() => onSelect(pane.name)}
        >
          <span
            aria-label={`${status.title} status`}
            className={`tmux-session-status-dot ${status.kind}`}
            title={status.title}
          />
          <span className="tmux-session-name">{displayName}</span>
          {wake && <span className="tmux-session-wake">{wake}</span>}
          {stale && <span className="tmux-session-stale">{stale}</span>}
          <span className="tmux-session-detail">{inGroup ? tmuxPaneGroupDetail(pane) : tmuxPaneDetail(pane)}</span>
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
        <button
          aria-label={isPinned ? `Unpin ${displayName}` : `Pin ${displayName}`}
          aria-pressed={isPinned}
          className={`tmux-session-pin ${isPinned ? "active" : ""}`}
          title={isPinned ? "Unpin pane" : "Pin pane to top"}
          type="button"
          onClick={() => onTogglePin(pane.name)}
        >
          <Pin aria-hidden="true" fill={isPinned ? "currentColor" : "none"} size={12} />
        </button>
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
          {pinned.map((pane) => renderPane(pane, false))}
        </div>
      )}
      {groups.map((group, index) => {
        if (group.session === null) {
          return (
            <div className="tmux-session-group" key="ungrouped">
              {group.panes.map((pane) => renderPane(pane, false))}
            </div>
          );
        }
        const session = group.session;
        const collapsed = isTmuxSessionGroupCollapsed(groupPreferences, session);
        const containsSelected = group.panes.some((pane) => pane.name === selected);
        const groupUnseen = group.panes.some(unseen);
        const aggregate = aggregateTmuxSessionStatus(group.panes);
        const panesId = `tmux-session-group-${index}`;
        const paneCount = `${group.panes.length} ${group.panes.length === 1 ? "pane" : "panes"}`;
        const summary = `${session}, ${paneCount}${collapsed ? `, ${aggregate.title}` : ""}${groupUnseen ? ", new output" : ""}${collapsed && containsSelected ? ", selected pane inside" : ""}`;
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
              <span aria-hidden="true" className="tmux-session-group-count">{group.panes.length}</span>
            </button>
            {!collapsed && (
              <div className="tmux-session-group-panes" id={panesId}>
                {group.panes.map((pane) => renderPane(pane, true))}
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
