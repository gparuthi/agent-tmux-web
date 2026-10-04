import { Command, X } from "lucide-react";
import { useEffect, useState } from "react";

import type { TmuxActionDto, TmuxActionsDto } from "../shared/api.js";
import { readApiErrorMessage } from "./newAgent.js";
import { groupTmuxActions, tmuxActionConfirmSteps, type TmuxActionConfirmStep } from "./tmuxActions.js";

type TmuxActionsSheetProps = {
  paneName: string;
  loadActions: () => Promise<TmuxActionsDto>;
  runAction: (action: TmuxActionDto) => Promise<string>;
  onResult: (result: { action: TmuxActionDto; output?: string; error?: string }) => void;
  onClose: () => void;
  initialActions?: TmuxActionsDto | null;
};

export function TmuxActionsSheet({ paneName, loadActions, runAction, onResult, onClose, initialActions = null }: TmuxActionsSheetProps) {
  const [listing, setListing] = useState<TmuxActionsDto | null>(initialActions);
  const [pending, setPending] = useState<{ action: TmuxActionDto; steps: TmuxActionConfirmStep[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    loadActions().then((loaded) => {
      if (!cancelled) {
        setListing(loaded);
      }
    }, (loadError: unknown) => {
      if (!cancelled) {
        setError(readApiErrorMessage(loadError));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [loadActions]);

  async function run(action: TmuxActionDto) {
    setBusy(true);
    setError("");
    try {
      onResult({ action, output: await runAction(action) });
    } catch (runError) {
      onResult({ action, error: readApiErrorMessage(runError) });
    }
  }

  function choose(action: TmuxActionDto) {
    const steps = tmuxActionConfirmSteps(action);
    if (steps.length === 0) {
      void run(action);
      return;
    }
    setPending({ action, steps });
  }

  function confirm() {
    if (!pending) {
      return;
    }
    const rest = pending.steps.slice(1);
    if (rest.length === 0) {
      void run(pending.action);
      return;
    }
    setPending({ action: pending.action, steps: rest });
  }

  const step = pending?.steps[0];
  return (
    <div className="new-agent-backdrop" role="presentation" onClick={(event) => event.target === event.currentTarget && onClose()}>
      <div aria-label="Pane actions" aria-modal="true" className="new-agent-sheet pane-actions-sheet" role="dialog">
        <header className="new-agent-header">
          <strong><Command aria-hidden="true" size={16} /> Actions</strong>
          <button aria-label="Close" className="new-agent-close" title="Close" type="button" onClick={onClose}><X size={16} /></button>
        </header>
        <div className="new-agent-muted window-snooze-target">{listing?.header || paneName}</div>
        {pending && step ? (
          <div className="pane-actions-confirm" role="alertdialog" aria-label={`Confirm ${pending.action.name}`}>
            <strong>{step === "question" ? pending.action.confirm : `Run "${pending.action.name}"?`}</strong>
            {step === "confirm" && pending.action.desc && <span>{pending.action.desc}</span>}
            <div className="pane-actions-confirm-buttons">
              <button disabled={busy} type="button" onClick={() => setPending(null)}>Cancel</button>
              <button className={step === "question" ? "danger" : "new-agent-start"} disabled={busy} type="button" onClick={confirm}>
                {busy ? "Running…" : step === "question" ? "Yes, run it" : pending.steps.length > 1 ? "Continue" : "Run"}
              </button>
            </div>
          </div>
        ) : (
          <div className="pane-actions-list">
            {listing === null && !error && <span className="new-agent-muted">Loading…</span>}
            {listing?.actions.length === 0 && <span className="new-agent-muted">No actions for this pane.</span>}
            {listing && groupTmuxActions(listing.actions).map(({ group, actions }) => (
              <div className="pane-actions-group" key={group || "actions"} role="group" aria-label={group || "Actions"}>
                {group && <div className="new-agent-label">{group}</div>}
                {actions.map((action) => (
                  <button disabled={busy} key={action.name} title={action.desc} type="button" onClick={() => choose(action)}>
                    <span className="pane-actions-name">{action.name}</span>
                    {action.desc && <span className="pane-actions-desc">{action.desc}</span>}
                  </button>
                ))}
              </div>
            ))}
          </div>
        )}
        {error && <div className="new-agent-error" role="alert">{error}</div>}
      </div>
    </div>
  );
}
