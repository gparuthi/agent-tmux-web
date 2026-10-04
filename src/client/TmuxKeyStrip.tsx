import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, CornerDownLeft } from "lucide-react";
import type { MouseEvent, ReactNode } from "react";

import type { KeyStripKey, KeyStripModifier } from "./keyStripCombos.js";

type TmuxKeyStripProps = {
  armed: KeyStripModifier | null;
  onToggleModifier: (modifier: KeyStripModifier) => void;
  onKey: (key: KeyStripKey) => void;
};

// Keeps focus (and the iOS soft keyboard) on the input while a strip key is tapped.
function keepInputFocus(event: MouseEvent<HTMLButtonElement>) {
  event.preventDefault();
}

export function TmuxKeyStrip({ armed, onToggleModifier, onKey }: TmuxKeyStripProps) {
  const key = (name: KeyStripKey, label: string, content: ReactNode, className?: string) => (
    <button aria-label={label} className={className} title={label} type="button" onMouseDown={keepInputFocus} onClick={() => onKey(name)}>
      {content}
    </button>
  );
  const modifier = (name: KeyStripModifier, label: string, content: string) => (
    <button
      aria-label={label}
      aria-pressed={armed === name}
      className={`modifier-key ${armed === name ? "armed" : ""}`}
      title={armed === name ? `${label} armed: the next key is sent with ${label}` : `${label}: tap, then press a key`}
      type="button"
      onMouseDown={keepInputFocus}
      onClick={() => onToggleModifier(name)}
    >
      {content}
    </button>
  );
  return (
    <div aria-label="Terminal keys" className="tmux-soft-keys tmux-key-strip" role="group">
      {key("Escape", "Escape", "Esc")}
      {key("Tab", "Tab", "Tab")}
      {modifier("ctrl", "Control", "^")}
      {modifier("alt", "Option", "⌥")}
      {key("Up", "Arrow up", <ArrowUp aria-hidden="true" size={15} />, "icon-key")}
      {key("Down", "Arrow down", <ArrowDown aria-hidden="true" size={15} />, "icon-key")}
      {key("Left", "Arrow left", <ArrowLeft aria-hidden="true" size={15} />, "icon-key")}
      {key("Right", "Arrow right", <ArrowRight aria-hidden="true" size={15} />, "icon-key")}
      {key("Enter", "Enter", <CornerDownLeft aria-hidden="true" size={15} />, "icon-key")}
    </div>
  );
}
