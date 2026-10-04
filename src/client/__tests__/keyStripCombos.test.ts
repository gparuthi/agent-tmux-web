import { describe, expect, it } from "vitest";

import {
  insertedCharacter,
  isRawTypedCharacter,
  rawKeyBytes,
  tmuxKeyName,
  toggleKeyStripModifier,
  typedKeyFromBeforeInput,
  typedKeyFromKeyDown
} from "../keyStripCombos.js";

const keyDown = (key: string, extra: Partial<{ keyCode: number; isComposing: boolean; ctrlKey: boolean; metaKey: boolean; altKey: boolean }> = {}) => ({
  key,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  ...extra
});

describe("key strip modifiers", () => {
  it("arms, switches and disarms sticky modifiers", () => {
    expect(toggleKeyStripModifier(null, "ctrl")).toBe("ctrl");
    expect(toggleKeyStripModifier("ctrl", "ctrl")).toBeNull();
    expect(toggleKeyStripModifier("ctrl", "alt")).toBe("alt");
    expect(toggleKeyStripModifier("alt", "alt")).toBeNull();
  });

  it("names tmux keys for strip keys and typed characters", () => {
    expect(tmuxKeyName("Escape", null)).toBe("Escape");
    expect(tmuxKeyName("Up", null)).toBe("Up");
    expect(tmuxKeyName("Up", "ctrl")).toBe("C-Up");
    expect(tmuxKeyName("Left", "alt")).toBe("M-Left");
    expect(tmuxKeyName("Tab", "ctrl")).toBe("Tab");
    expect(tmuxKeyName("d", "ctrl")).toBe("C-d");
    expect(tmuxKeyName("D", "ctrl")).toBe("C-d");
    expect(tmuxKeyName("b", "alt")).toBe("M-b");
    expect(tmuxKeyName(";", "alt")).toBe("M-;");
    expect(tmuxKeyName("1", "ctrl")).toBeNull();
    expect(tmuxKeyName(" ", "alt")).toBeNull();
    expect(tmuxKeyName("é", "alt")).toBeNull();
    expect(tmuxKeyName("d", null)).toBeNull();
  });

  it("encodes raw terminal bytes with ctrl masking and an ESC prefix for alt", () => {
    expect(rawKeyBytes("Escape", null)).toBe("\x1b");
    expect(rawKeyBytes("Tab", "ctrl")).toBe("\t");
    expect(rawKeyBytes("Enter", null)).toBe("\r");
    expect(rawKeyBytes("Up", null)).toBe("\x1b[A");
    expect(rawKeyBytes("Left", "ctrl")).toBe("\x1b[1;5D");
    expect(rawKeyBytes("Right", "alt")).toBe("\x1b[1;3C");
    expect(rawKeyBytes("d", "ctrl")).toBe("\x04");
    expect(rawKeyBytes("C", "ctrl")).toBe("\x03");
    expect(rawKeyBytes("[", "ctrl")).toBe("\x1b");
    expect(rawKeyBytes("b", "alt")).toBe("\x1bb");
    expect(rawKeyBytes("1", "ctrl")).toBeNull();
    expect(rawKeyBytes("d", null)).toBeNull();
  });
});

describe("capturing the next soft-keyboard key", () => {
  it("uses keydown when the browser reports the character", () => {
    expect(typedKeyFromKeyDown(keyDown("d"))).toBe("d");
    expect(typedKeyFromKeyDown(keyDown("Enter"))).toBeNull();
    expect(typedKeyFromKeyDown(keyDown("d", { ctrlKey: true }))).toBeNull();
  });

  it("defers iOS Unidentified/229 keydowns to beforeinput", () => {
    expect(typedKeyFromKeyDown(keyDown("Unidentified", { keyCode: 229 }))).toBeNull();
    expect(typedKeyFromKeyDown(keyDown("d", { keyCode: 229 }))).toBeNull();
    expect(typedKeyFromKeyDown(keyDown("d", { isComposing: true }))).toBeNull();
    expect(typedKeyFromBeforeInput({ inputType: "insertText", data: "d" })).toBe("d");
    expect(typedKeyFromBeforeInput({ inputType: "insertText", data: "dog" })).toBeNull();
    expect(typedKeyFromBeforeInput({ inputType: "insertCompositionText", data: "d" })).toBeNull();
    expect(typedKeyFromBeforeInput({ inputType: "deleteContentBackward", data: null })).toBeNull();
  });

  it("finds the character an input event inserted so it can be reverted", () => {
    expect(insertedCharacter("", "d")).toBe("d");
    expect(insertedCharacter("echo hi", "echo hid")).toBe("d");
    expect(insertedCharacter("echo hi", "echdo hi")).toBe("d");
    expect(insertedCharacter("aa", "aaa")).toBe("a");
    expect(insertedCharacter("echo", "echo hi")).toBeNull();
    expect(insertedCharacter("echo", "ech")).toBeNull();
    expect(insertedCharacter("abc", "xbcd")).toBeNull();
  });

  it("only rewrites single printable characters typed into the raw terminal", () => {
    expect(isRawTypedCharacter("d")).toBe(true);
    expect(isRawTypedCharacter("\r")).toBe(false);
    expect(isRawTypedCharacter("dd")).toBe(false);
  });
});
