import { ChevronsRight, Leaf } from "lucide-react";

type ZenNextButtonProps = {
  // Empty when no other pane is active.
  next: string;
  onSelect: (name: string) => void;
};

// Title-bar button beside the session name: one tap jumps to the next active pane.
export function ZenNextButton({ next, onSelect }: ZenNextButtonProps) {
  return (
    <button
      aria-label="Next active session"
      className="tmux-session-next-button"
      disabled={!next}
      title={next ? "Next active session" : "No other active session"}
      type="button"
      onClick={() => onSelect(next)}
    >
      <ChevronsRight aria-hidden="true" size={17} />
    </button>
  );
}

// Shown beside the Sessions heading while zen is on; a tap turns it off.
export function ZenChip({ onExit }: { onExit: () => void }) {
  return (
    <button aria-label="Zen mode on, tap to turn off" className="tmux-zen-chip" title="Zen mode: only recently worked sessions. Tap to turn off" type="button" onClick={onExit}>
      <Leaf aria-hidden="true" size={11} />
      <span>Zen</span>
    </button>
  );
}
