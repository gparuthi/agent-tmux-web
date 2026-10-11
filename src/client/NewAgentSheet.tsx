import { Bot, X } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";

import type { AgentsDto, StartAgentResultDto } from "../shared/api.js";
import { clearLegacyNewAgentChoice, defaultNewAgentSelection, readApiErrorMessage, resolveNewAgentDirectory } from "./newAgent.js";

type NewAgentSheetProps = {
  loadAgents: () => Promise<AgentsDto>;
  startAgent: (agent: string, cwd: string) => Promise<StartAgentResultDto>;
  onStarted: (result: StartAgentResultDto) => void;
  onClose: () => void;
  initialAgents?: AgentsDto | null;
};

export function NewAgentSheet({ loadAgents, startAgent, onStarted, onClose, initialAgents = null }: NewAgentSheetProps) {
  const [agents, setAgents] = useState<AgentsDto | null>(initialAgents);
  const initial = defaultNewAgentSelection(initialAgents);
  const [agent, setAgent] = useState(initial.agent);
  const [directory, setDirectory] = useState(initial.directory);
  const [typedDirectory, setTypedDirectory] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    clearLegacyNewAgentChoice(readLocalStorage());
  }, []);

  useEffect(() => {
    let cancelled = false;
    loadAgents().then((loaded) => {
      if (cancelled) {
        return;
      }
      setAgents(loaded);
      const selection = defaultNewAgentSelection(loaded);
      setAgent((current) => (current && loaded.agents.some((entry) => entry.id === current) ? current : selection.agent));
      setDirectory((current) => current || selection.directory);
    }, (loadError: unknown) => {
      if (!cancelled) {
        setError(readApiErrorMessage(loadError));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [loadAgents]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const cwd = resolveNewAgentDirectory(directory, typedDirectory);
    if (!agent || !cwd) {
      setError(!agent ? "Pick an agent." : "Pick a directory.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const result = await startAgent(agent, cwd);
      onStarted(result);
    } catch (startError) {
      setError(readApiErrorMessage(startError));
    } finally {
      setBusy(false);
    }
  }

  const selectedLabel = agents?.agents.find((entry) => entry.id === agent)?.label ?? "agent";
  return (
    <div className="new-agent-backdrop" role="presentation" onClick={(event) => event.target === event.currentTarget && onClose()}>
      <form aria-label="New agent" aria-modal="true" className="new-agent-sheet" role="dialog" onSubmit={submit}>
        <header className="new-agent-header">
          <strong><Bot aria-hidden="true" size={16} /> New agent</strong>
          <button aria-label="Close" className="new-agent-close" title="Close" type="button" onClick={onClose}><X size={16} /></button>
        </header>
        <div className="new-agent-label">Agent</div>
        <div className="new-agent-choices" role="radiogroup" aria-label="Agent">
          {agents === null && <span className="new-agent-muted">Loading…</span>}
          {agents?.agents.length === 0 && <span className="new-agent-muted">No agent binaries found.</span>}
          {agents?.agents.map((entry) => (
            <button
              aria-checked={agent === entry.id}
              className={agent === entry.id ? "active" : ""}
              key={entry.id}
              role="radio"
              type="button"
              onClick={() => setAgent(entry.id)}
            >
              {entry.label}
            </button>
          ))}
        </div>
        <div className="new-agent-label">Directory</div>
        <div className="new-agent-directories" role="radiogroup" aria-label="Directory">
          {agents?.directories.map((entry) => (
            <button
              aria-checked={!typedDirectory.trim() && directory === entry.path}
              className={!typedDirectory.trim() && directory === entry.path ? "active" : ""}
              key={entry.path}
              role="radio"
              title={entry.path}
              type="button"
              onClick={() => {
                setDirectory(entry.path);
                setTypedDirectory("");
              }}
            >
              <span className="new-agent-directory-path">{entry.label}</span>
              <span className="new-agent-directory-source">{entry.source === "pane" ? "open" : "repo"}</span>
            </button>
          ))}
        </div>
        <input
          aria-label="Other directory"
          autoCapitalize="off"
          autoCorrect="off"
          className="new-agent-path"
          placeholder="Other path, e.g. ~/work/project"
          spellCheck={false}
          value={typedDirectory}
          onChange={(event) => setTypedDirectory(event.target.value)}
        />
        {error && <div className="new-agent-error" role="alert">{error}</div>}
        <button className="new-agent-start" disabled={busy || !agent} type="submit">
          {busy ? "Starting…" : `Start ${selectedLabel} in ${agents?.session ?? "main"}`}
        </button>
      </form>
    </div>
  );
}

function readLocalStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}
