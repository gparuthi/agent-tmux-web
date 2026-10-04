import { AlarmClock, Sunrise, X } from "lucide-react";
import { useState, type FormEvent } from "react";

import { formatWindowWake, isValidWindowSnoozeDuration, WINDOW_SNOOZE_PRESETS } from "../shared/windowSnooze.js";
import { readApiErrorMessage } from "./newAgent.js";

type WindowSnoozeSheetProps = {
  paneName: string;
  // Set when the window is already snoozed: picking a duration moves its wake time.
  snoozedUntilMs?: number;
  nowMs?: number;
  snooze: (duration: string) => Promise<void>;
  wake: () => Promise<void>;
  onClose: () => void;
};

// Lower-case and trimmed, so "3H " still counts as tmux-hide-window's "3h".
export function normalizeWindowSnoozeInput(value: string): string {
  return value.trim().toLowerCase();
}

export function WindowSnoozeSheet({ paneName, snoozedUntilMs, nowMs = Date.now(), snooze, wake, onClose }: WindowSnoozeSheetProps) {
  const [custom, setCustom] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (actionError) {
      setError(readApiErrorMessage(actionError));
      setBusy(false);
    }
  }

  function submitCustom(event: FormEvent) {
    event.preventDefault();
    const duration = normalizeWindowSnoozeInput(custom);
    if (!isValidWindowSnoozeDuration(duration)) {
      setError("Use a number and a unit: 30m, 3h, 2d, or 2w.");
      return;
    }
    void run(() => snooze(duration));
  }

  return (
    <div className="new-agent-backdrop" role="presentation" onClick={(event) => event.target === event.currentTarget && onClose()}>
      <form aria-label="Snooze window" aria-modal="true" className="new-agent-sheet window-snooze-sheet" role="dialog" onSubmit={submitCustom}>
        <header className="new-agent-header">
          <strong><AlarmClock aria-hidden="true" size={16} /> Snooze window</strong>
          <button aria-label="Close" className="new-agent-close" title="Close" type="button" onClick={onClose}><X size={16} /></button>
        </header>
        <div className="new-agent-muted window-snooze-target">
          {snoozedUntilMs ? `${paneName} · ${formatWindowWake(snoozedUntilMs, nowMs)}` : `Hides ${paneName}'s window until then`}
        </div>
        <div className="window-snooze-presets" role="group" aria-label="Snooze for">
          {WINDOW_SNOOZE_PRESETS.map((preset) => (
            <button disabled={busy} key={preset.duration} type="button" onClick={() => void run(() => snooze(preset.duration))}>
              {preset.label}
            </button>
          ))}
        </div>
        <div className="window-snooze-custom">
          <input
            aria-label="Custom snooze, e.g. 45m or 2d"
            autoCapitalize="off"
            autoCorrect="off"
            className="new-agent-path"
            disabled={busy}
            placeholder="Custom: 45m, 6h, 2d, 2w"
            spellCheck={false}
            value={custom}
            onChange={(event) => setCustom(event.target.value)}
          />
          <button className="new-agent-start" disabled={busy || !custom.trim()} type="submit">Snooze</button>
        </div>
        {snoozedUntilMs !== undefined && (
          <button className="window-snooze-wake" disabled={busy} type="button" onClick={() => void run(wake)}>
            <Sunrise aria-hidden="true" size={15} /> Wake now
          </button>
        )}
        {error && <div className="new-agent-error" role="alert">{error}</div>}
      </form>
    </div>
  );
}
