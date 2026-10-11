import { describe, expect, it, vi } from "vitest";

import {
  installTmuxRailShortcuts,
  isRailShortcutTypingTarget,
  RAIL_SHORTCUT_BLOCKING_SELECTOR,
  railShortcutDigit,
  railShortcutsBlocked
} from "../tmuxRailShortcuts.js";

// Node has no DOM; a fake element answers closest() for the selector parts it (or an ancestor) matches.
function fakeElement(...matches: string[]): EventTarget {
  const element = new EventTarget() as EventTarget & { closest(selector: string): unknown };
  element.closest = (selector: string) => selector.split(",").some((part) => matches.includes(part.trim())) ? element : null;
  return element;
}

const body = fakeElement();
const textInput = fakeElement("input");
const tmuxInput = fakeElement("textarea");
const editable = fakeElement('[contenteditable]:not([contenteditable="false"])');
// xterm's hidden helper textarea lives inside .xterm.
const xtermTextarea = fakeElement("textarea", ".xterm");
const xtermScreen = fakeElement(".xterm");

type KeyInit = { code: string; key?: string; target: EventTarget; altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean; isComposing?: boolean };

function keydown({ code, key = code.replace("Digit", ""), target, altKey = false, ctrlKey = false, metaKey = false, shiftKey = false, isComposing = false }: KeyInit) {
  const event = new Event("keydown", { cancelable: true });
  Object.defineProperties(event, {
    code: { value: code },
    key: { value: key },
    target: { value: target },
    altKey: { value: altKey },
    ctrlKey: { value: ctrlKey },
    metaKey: { value: metaKey },
    shiftKey: { value: shiftKey },
    isComposing: { value: isComposing }
  });
  const stopPropagation = vi.spyOn(event, "stopPropagation");
  return { event, stopPropagation };
}

function setup({ blocked = false, rows = 3 } = {}) {
  const win = new EventTarget();
  const select = vi.fn((digit: number) => digit <= rows);
  const state = { blocked };
  const remove = installTmuxRailShortcuts(win, { blocked: () => state.blocked, select });
  const press = (init: KeyInit) => {
    const pressed = keydown(init);
    win.dispatchEvent(pressed.event);
    return pressed;
  };
  return { press, remove, select, state };
}

describe("rail shortcut keys", () => {
  it("reads the physical digit key, so macOS Option+1 (key ¡) still means 1", () => {
    expect(railShortcutDigit("Digit1")).toBe(1);
    expect(railShortcutDigit("Digit9")).toBe(9);
    expect(railShortcutDigit("Digit0")).toBeNull();
    expect(railShortcutDigit("Numpad1")).toBeNull();
    expect(railShortcutDigit("KeyA")).toBeNull();
  });

  it("treats inputs, textareas, contenteditable and the xterm terminal as typing", () => {
    expect(isRailShortcutTypingTarget(textInput)).toBe(true);
    expect(isRailShortcutTypingTarget(tmuxInput)).toBe(true);
    expect(isRailShortcutTypingTarget(editable)).toBe(true);
    expect(isRailShortcutTypingTarget(xtermTextarea)).toBe(true);
    expect(isRailShortcutTypingTarget(xtermScreen)).toBe(true);
    expect(isRailShortcutTypingTarget(body)).toBe(false);
    expect(isRailShortcutTypingTarget(null)).toBe(false);
  });

  it("selects the nth row on a plain digit outside text entry", () => {
    const { press, select } = setup();
    const { event, stopPropagation } = press({ code: "Digit2", target: body });
    expect(select).toHaveBeenCalledWith(2);
    expect(event.defaultPrevented).toBe(true);
    expect(stopPropagation).toHaveBeenCalled();
  });

  it("lets plain digits through while typing in an input, textarea, contenteditable or xterm", () => {
    const { press, select } = setup();
    for (const target of [textInput, tmuxInput, editable, xtermTextarea]) {
      const { event, stopPropagation } = press({ code: "Digit1", target });
      expect(event.defaultPrevented).toBe(false);
      expect(stopPropagation).not.toHaveBeenCalled();
    }
    expect(select).not.toHaveBeenCalled();
  });

  it("takes Alt/Option+digit inside the input box and the raw terminal before the input sees it", () => {
    const { press, select } = setup();
    const inInput = press({ code: "Digit1", key: "¡", target: tmuxInput, altKey: true });
    expect(select).toHaveBeenLastCalledWith(1);
    expect(inInput.event.defaultPrevented).toBe(true);
    expect(inInput.stopPropagation).toHaveBeenCalled();

    const inXterm = press({ code: "Digit3", key: "£", target: xtermTextarea, altKey: true });
    expect(select).toHaveBeenLastCalledWith(3);
    expect(inXterm.event.defaultPrevented).toBe(true);
    expect(inXterm.stopPropagation).toHaveBeenCalled();
  });

  it("swallows Alt+digit past the last row, but leaves a plain digit past it alone", () => {
    const { press } = setup({ rows: 2 });
    expect(press({ code: "Digit7", target: xtermTextarea, altKey: true }).event.defaultPrevented).toBe(true);
    expect(press({ code: "Digit7", target: body }).event.defaultPrevented).toBe(false);
  });

  it("leaves Cmd, Ctrl and Shift digits to the browser and the page", () => {
    const { press, select } = setup();
    for (const modifiers of [{ metaKey: true }, { ctrlKey: true }, { shiftKey: true }, { altKey: true, metaKey: true }, { altKey: true, shiftKey: true }]) {
      const { event } = press({ code: "Digit1", target: body, ...modifiers });
      expect(event.defaultPrevented).toBe(false);
    }
    expect(select).not.toHaveBeenCalled();
  });

  it("ignores IME composition keystrokes", () => {
    const { press, select } = setup();
    press({ code: "Digit1", target: body, isComposing: true });
    press({ code: "Digit1", target: tmuxInput, altKey: true, isComposing: true });
    expect(select).not.toHaveBeenCalled();
  });

  it("ignores digits, plain or Alt, while a sheet, dialog or menu is open", () => {
    const { press, select, state } = setup({ blocked: true });
    const plain = press({ code: "Digit1", target: body });
    const alt = press({ code: "Digit1", target: tmuxInput, altKey: true });
    expect(plain.event.defaultPrevented).toBe(false);
    expect(alt.event.defaultPrevented).toBe(false);
    expect(select).not.toHaveBeenCalled();

    state.blocked = false;
    press({ code: "Digit1", target: body });
    expect(select).toHaveBeenCalledWith(1);
  });

  it("stops listening once removed", () => {
    const { press, remove, select } = setup();
    remove();
    press({ code: "Digit1", target: body });
    expect(select).not.toHaveBeenCalled();
  });

  it("treats aria-modal sheets, dialogs, the open settings menu and the slash menu as blocking", () => {
    for (const part of ['[aria-modal="true"]', '[role="dialog"]', "details[open]", '[role="listbox"]']) {
      expect(RAIL_SHORTCUT_BLOCKING_SELECTOR).toContain(part);
    }
    expect(railShortcutsBlocked({ querySelector: () => null })).toBe(false);
    expect(railShortcutsBlocked({ querySelector: (selector: string) => selector === RAIL_SHORTCUT_BLOCKING_SELECTOR ? body as Element : null })).toBe(true);
  });
});
