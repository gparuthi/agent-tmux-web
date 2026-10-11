// Keys 1-9 jump to the rail's rows; Alt/Option+1-9 does the same while typing in an input or xterm.

type RailShortcutKeyEvent = Pick<KeyboardEvent, "code" | "altKey" | "ctrlKey" | "metaKey" | "shiftKey" | "isComposing" | "target">;

type RailShortcutOptions = {
  // True while a sheet, dialog or menu is open; digits then belong to it.
  blocked: () => boolean;
  // Selects the nth visible rail row; false when the rail has no such row.
  select: (digit: number) => boolean;
};

const TYPING_SELECTOR = 'input, textarea, select, [contenteditable]:not([contenteditable="false"]), .xterm';

// Sheets are aria-modal dialogs, the settings menu is a <details>, the slash menu a listbox.
export const RAIL_SHORTCUT_BLOCKING_SELECTOR = '[aria-modal="true"], [role="dialog"], [role="alertdialog"], [role="listbox"], details[open]';

// event.code, not event.key: macOS Option+1 reports key "¡".
export function railShortcutDigit(code: string): number | null {
  const match = /^Digit([1-9])$/.exec(code);
  return match ? Number(match[1]) : null;
}

export function isRailShortcutTypingTarget(target: EventTarget | null): boolean {
  const element = target as Partial<Element> | null;
  return typeof element?.closest === "function" && element.closest(TYPING_SELECTOR) !== null;
}

export function railShortcutsBlocked(root: Pick<ParentNode, "querySelector">): boolean {
  return root.querySelector(RAIL_SHORTCUT_BLOCKING_SELECTOR) !== null;
}

// The digit a keydown selects, or null to leave the key alone. Cmd/Ctrl+digit stay the browser's tab keys.
export function railShortcutForKeyEvent(event: RailShortcutKeyEvent, blocked: boolean): number | null {
  const digit = railShortcutDigit(event.code);
  if (digit === null || blocked || event.isComposing || event.ctrlKey || event.metaKey || event.shiftKey) {
    return null;
  }
  if (event.altKey) {
    return digit;
  }
  return isRailShortcutTypingTarget(event.target) ? null : digit;
}

// Listens in the capture phase so Alt+digit is taken before xterm's textarea handler sees it.
export function installTmuxRailShortcuts(target: EventTarget, options: RailShortcutOptions): () => void {
  const handleKeyDown = (event: Event) => {
    const keyEvent = event as KeyboardEvent;
    const digit = railShortcutForKeyEvent(keyEvent, options.blocked());
    if (digit === null) {
      return;
    }
    const selected = options.select(digit);
    // Alt+digit always belongs to the rail, so Option's "¡" never lands in an input or the agent.
    if (selected || keyEvent.altKey) {
      event.preventDefault();
      event.stopPropagation();
    }
  };
  target.addEventListener("keydown", handleKeyDown, { capture: true });
  return () => target.removeEventListener("keydown", handleKeyDown, { capture: true });
}
