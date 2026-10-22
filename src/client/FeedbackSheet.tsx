import { MessageSquare, X } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";

import { readApiErrorMessage } from "./newAgent.js";

type FeedbackSheetProps = {
  // The pane the server will type into is resolved server-side; this is only the pane being viewed.
  paneName: string;
  // Captured before the sheet opened; null when capture failed (see screenshotError).
  screenshot: Blob | null;
  screenshotError?: string;
  send: (input: { message: string; screenshot: Blob | null }) => Promise<void>;
  onClose: () => void;
};

export function FeedbackSheet({ paneName, screenshot, screenshotError = "", send, onClose }: FeedbackSheetProps) {
  const [message, setMessage] = useState("");
  const [includeScreenshot, setIncludeScreenshot] = useState(true);
  const [thumbnail, setThumbnail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!screenshot) {
      return;
    }
    const url = URL.createObjectURL(screenshot);
    setThumbnail(url);
    return () => URL.revokeObjectURL(url);
  }, [screenshot]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!message.trim()) {
      setError("Write some feedback first.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await send({ message: message.trim(), screenshot: includeScreenshot ? screenshot : null });
    } catch (sendError) {
      setError(readApiErrorMessage(sendError));
      setBusy(false);
    }
  }

  return (
    <div className="new-agent-backdrop" role="presentation" onClick={(event) => event.target === event.currentTarget && onClose()}>
      <form aria-label="Send feedback" aria-modal="true" className="new-agent-sheet feedback-sheet" role="dialog" onSubmit={submit}>
        <header className="new-agent-header">
          <strong><MessageSquare aria-hidden="true" size={16} /> Send feedback</strong>
          <button aria-label="Close" className="new-agent-close" title="Close" type="button" onClick={onClose}><X size={16} /></button>
        </header>
        <div className="new-agent-muted feedback-sheet-target">{`Goes to the Atw session. Viewing ${paneName || "no pane"}.`}</div>
        <textarea
          aria-label="Feedback"
          autoFocus
          className="feedback-sheet-text"
          disabled={busy}
          placeholder="What should change?"
          rows={5}
          value={message}
          onChange={(event) => setMessage(event.target.value)}
        />
        <label className="feedback-sheet-shot">
          <input
            checked={includeScreenshot && screenshot !== null}
            disabled={busy || screenshot === null}
            type="checkbox"
            onChange={(event) => setIncludeScreenshot(event.target.checked)}
          />
          <span>{screenshot === null ? (screenshotError || "No screenshot") : "Include screenshot"}</span>
          {thumbnail && includeScreenshot && <img alt="Screenshot preview" src={thumbnail} />}
        </label>
        {error && <div className="new-agent-error" role="alert">{error}</div>}
        <button className="new-agent-start" disabled={busy || !message.trim()} type="submit">{busy ? "Sending" : "Send"}</button>
      </form>
    </div>
  );
}
