import { ChevronRight } from "lucide-react";
import { useState } from "react";

import type { ClosedSessionDto, ReopenClosedSessionMode } from "../shared/api.js";
import { formatTmuxLastPrompt } from "./TmuxSessionList.js";

const PANES_ID = "tmux-closed-sessions";

type ClosedSessionsSectionProps = {
  entries: ClosedSessionDto[];
  onReopen: (entry: ClosedSessionDto, mode: ReopenClosedSessionMode) => Promise<void>;
  initialExpanded?: boolean;
  nowMs?: number;
};

// "closed 5m ago", "closed just now".
export function formatClosedAgo(closedAtMs: number, nowMs: number): string {
  return `closed ${formatTmuxLastPrompt(closedAtMs, nowMs) || "just now"}`;
}

export function ClosedSessionsSection({ entries, onReopen, initialExpanded = false, nowMs = Date.now() }: ClosedSessionsSectionProps) {
  const [expanded, setExpanded] = useState(initialExpanded);
  const [busy, setBusy] = useState<{ sessionId: string; mode: ReopenClosedSessionMode } | null>(null);
  if (entries.length === 0) {
    return null;
  }

  async function reopen(entry: ClosedSessionDto, mode: ReopenClosedSessionMode) {
    setBusy({ sessionId: entry.sessionId, mode });
    try {
      await onReopen(entry, mode);
    } finally {
      setBusy(null);
    }
  }

  function renderEntry(entry: ClosedSessionDto) {
    const closed = formatClosedAgo(entry.closedAtMs, nowMs);
    const working = (mode: ReopenClosedSessionMode) => busy?.sessionId === entry.sessionId && busy.mode === mode;
    return (
      <div className="tmux-session-row tmux-closed-session-row" key={entry.sessionId}>
        <span className="tmux-closed-session-title" title={`${entry.title} (${entry.agent} · ${entry.cwd}), ${closed}`}>
          <span className="tmux-session-name">{entry.title}</span>
          <span className="tmux-session-sub">
            <span className="tmux-session-sub-session">{entry.cwdLabel}</span>
            <span aria-hidden="true" className="tmux-session-sub-separator">·</span>
            <span className="tmux-session-last-prompt">{closed}</span>
          </span>
        </span>
        <span className="tmux-closed-session-actions">
          <button
            aria-label={`Resume ${entry.title}`}
            className="tmux-session-wake-button"
            disabled={busy !== null}
            title="Resume this session in a new window"
            type="button"
            onClick={() => void reopen(entry, "resume")}
          >
            {working("resume") ? "Resuming…" : "Resume"}
          </button>
          <button
            aria-label={`Start a fresh agent from the handoff of ${entry.title}`}
            className="tmux-session-wake-button"
            disabled={busy !== null || !entry.handoff}
            title={entry.handoff ? "Start a fresh agent from this session's ctx handoff" : "No ctx handoff saved for this session"}
            type="button"
            onClick={() => void reopen(entry, "handoff")}
          >
            {working("handoff") ? "Starting…" : "Handoff"}
          </button>
        </span>
      </div>
    );
  }

  return (
    <div aria-label="Recently closed sessions" className="tmux-session-group tmux-closed-sessions" role="group">
      <button
        aria-controls={expanded ? PANES_ID : undefined}
        aria-expanded={expanded}
        className="tmux-session-group-header"
        type="button"
        onClick={() => setExpanded((current) => !current)}
      >
        <ChevronRight aria-hidden="true" className="tmux-session-group-chevron" size={13} />
        <span className="tmux-session-group-name">Recently closed ({entries.length})</span>
      </button>
      {expanded && (
        <div className="tmux-session-group-panes" id={PANES_ID}>
          {entries.map((entry) => renderEntry(entry))}
        </div>
      )}
    </div>
  );
}
