export type KeyStripModifier = "ctrl" | "alt";
export type KeyStripKey = "Escape" | "Tab" | "Enter" | "Up" | "Down" | "Left" | "Right";

const ARROW_KEYS = new Set<string>(["Up", "Down", "Left", "Right"]);
const STRIP_KEYS = new Set<string>(["Escape", "Tab", "Enter", ...ARROW_KEYS]);
const RAW_ARROW_FINAL: Record<string, string> = { Up: "A", Down: "B", Right: "C", Left: "D" };
const RAW_PLAIN_KEYS: Record<string, string> = { Escape: "\x1b", Tab: "\t", Enter: "\r" };

type KeyDownLike = {
  key: string;
  keyCode?: number;
  isComposing?: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
};

type BeforeInputLike = {
  inputType: string;
  data: string | null;
};

export function isKeyStripKey(key: string): key is KeyStripKey {
  return STRIP_KEYS.has(key);
}

// Tapping the armed modifier again disarms it; tapping the other one switches.
export function toggleKeyStripModifier(armed: KeyStripModifier | null, modifier: KeyStripModifier): KeyStripModifier | null {
  return armed === modifier ? null : modifier;
}

// tmux send-keys name for a strip key or a typed character; null when the combo has no allowed name.
export function tmuxKeyName(key: string, modifier: KeyStripModifier | null): string | null {
  if (isKeyStripKey(key)) {
    return modifier && ARROW_KEYS.has(key) ? `${modifier === "ctrl" ? "C" : "M"}-${key}` : key;
  }
  if (modifier === "ctrl") {
    return /^[a-zA-Z]$/.test(key) ? `C-${key.toLowerCase()}` : null;
  }
  if (modifier === "alt") {
    return /^[\x21-\x7e]$/.test(key) ? `M-${key}` : null;
  }
  return null;
}

// Bytes for the raw terminal socket: ctrl masks to the C0 range, alt prefixes ESC.
export function rawKeyBytes(key: string, modifier: KeyStripModifier | null): string | null {
  if (ARROW_KEYS.has(key)) {
    const final = RAW_ARROW_FINAL[key];
    return modifier ? `\x1b[1;${modifier === "ctrl" ? 5 : 3}${final}` : `\x1b[${final}`;
  }
  if (isKeyStripKey(key)) {
    return RAW_PLAIN_KEYS[key];
  }
  if (modifier === "ctrl") {
    return /^[a-zA-Z@[\\\]^_]$/.test(key) ? String.fromCharCode(key.toUpperCase().charCodeAt(0) & 0x1f) : null;
  }
  if (modifier === "alt") {
    return /^[\x20-\x7e]$/.test(key) ? `\x1b${key}` : null;
  }
  return null;
}

// iOS soft keyboards often report "Unidentified"/229 on keydown; those fall through to beforeinput/input.
export function typedKeyFromKeyDown(event: KeyDownLike): string | null {
  if (event.isComposing || event.keyCode === 229 || event.ctrlKey || event.metaKey || event.altKey) {
    return null;
  }
  return event.key.length === 1 ? event.key : null;
}

export function typedKeyFromBeforeInput(event: BeforeInputLike): string | null {
  return event.inputType === "insertText" && event.data && event.data.length === 1 ? event.data : null;
}

// The single character an input event added, so the textarea can be reverted to `before`.
export function insertedCharacter(before: string, after: string): string | null {
  if (after.length !== before.length + 1) {
    return null;
  }
  let index = 0;
  while (index < before.length && before[index] === after[index]) {
    index += 1;
  }
  return after.slice(0, index) + after.slice(index + 1) === before ? after[index] : null;
}

// One printable character typed into xterm while a modifier is armed.
export function isRawTypedCharacter(data: string): boolean {
  return /^[\x20-\x7e]$/.test(data);
}
