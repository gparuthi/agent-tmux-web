import { PencilLine, X } from "lucide-react";
import { useState, type FormEvent } from "react";

import { sanitizeTmuxRenameName, TMUX_RENAME_MAX_LENGTH, tmuxRenameCommand } from "../shared/tmuxRename.js";
import { readApiErrorMessage } from "./newAgent.js";

type RenameSessionSheetProps = {
  paneName: string;
  agent: string;
  initialName?: string;
  rename: (name: string) => Promise<void>;
  onClose: () => void;
};

const AGENT_LABELS: Record<string, string> = { claude: "Claude", codex: "Codex", pi: "Pi" };

export function RenameSessionSheet({ paneName, agent, initialName = "", rename, onClose }: RenameSessionSheetProps) {
  const [name, setName] = useState(initialName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const command = tmuxRenameCommand(agent) ?? "/rename";

  async function submit(event: FormEvent) {
    event.preventDefault();
    const cleaned = sanitizeTmuxRenameName(name);
    if (!cleaned) {
      setError("Enter a name for the session.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await rename(cleaned);
    } catch (renameError) {
      setError(readApiErrorMessage(renameError));
      setBusy(false);
    }
  }

  return (
    <div className="new-agent-backdrop" role="presentation" onClick={(event) => event.target === event.currentTarget && onClose()}>
      <form aria-label="Rename session" aria-modal="true" className="new-agent-sheet window-snooze-sheet" role="dialog" onSubmit={submit}>
        <header className="new-agent-header">
          <strong><PencilLine aria-hidden="true" size={16} /> Rename session</strong>
          <button aria-label="Close" className="new-agent-close" title="Close" type="button" onClick={onClose}><X size={16} /></button>
        </header>
        <div className="new-agent-muted window-snooze-target">
          {`Types ${command} <name> into ${AGENT_LABELS[agent] ?? agent} in ${paneName}`}
        </div>
        <div className="window-snooze-custom">
          <input
            aria-label="Session name"
            autoFocus
            className="new-agent-path"
            disabled={busy}
            maxLength={TMUX_RENAME_MAX_LENGTH}
            placeholder="Session name"
            spellCheck={false}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          <button className="new-agent-start" disabled={busy || !name.trim()} type="submit">Rename</button>
        </div>
        {error && <div className="new-agent-error" role="alert">{error}</div>}
      </form>
    </div>
  );
}
