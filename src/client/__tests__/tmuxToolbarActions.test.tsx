import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { ToolbarCustomizeSheet } from "../ToolbarCustomizeSheet.js";
import { ToolbarInlineButtons, ToolbarMenuSection, type ToolbarActionItem } from "../TmuxToolbarButtons.js";
import {
  TOOLBAR_ACTION_ORDER,
  canKeepInToolbar,
  dragTargetIndex,
  inlineToolbarActions,
  maxInlineToolbarActions,
  parseToolbarLastUsed,
  parseToolbarPins,
  recentToolbarActions,
  reorderToolbarPins,
  togglePinnedToolbarAction,
  type ToolbarActionId
} from "../tmuxToolbarActions.js";

const all: ToolbarActionId[] = [...TOOLBAR_ACTION_ORDER];

describe("toolbar slot selection", () => {
  it("defaults to today's first three buttons with no history", () => {
    expect(inlineToolbarActions(all, [], {}, 3)).toEqual({ pinned: [], recent: ["view", "stop", "pin"] });
  });

  it("fills recents by most recent use, shown in today's order", () => {
    const lastUsed = { close: 30, refresh: 20, snooze: 10 };
    expect(recentToolbarActions(all, [], lastUsed).slice(0, 4)).toEqual(["close", "refresh", "snooze", "view"]);
    expect(inlineToolbarActions(all, [], lastUsed, 3).recent).toEqual(["refresh", "close", "snooze"]);
  });

  it("gives pins the first slots in pin order and shrinks recents", () => {
    const lastUsed = { close: 30, refresh: 20 };
    expect(inlineToolbarActions(all, ["refresh"], lastUsed, 3)).toEqual({ pinned: ["refresh"], recent: ["view", "close"] });
    expect(inlineToolbarActions(all, ["close", "view"], lastUsed, 3)).toEqual({ pinned: ["close", "view"], recent: ["refresh"] });
  });

  it("shows no recents once every slot is pinned", () => {
    expect(inlineToolbarActions(all, ["snooze", "pin", "stop"], { view: 99 }, 3)).toEqual({ pinned: ["snooze", "pin", "stop"], recent: [] });
  });

  it("keeps the earliest pins when the width cap drops below the pin count", () => {
    expect(inlineToolbarActions(all, ["close", "view", "pin"], {}, 2)).toEqual({ pinned: ["close", "view"], recent: [] });
    expect(inlineToolbarActions(all, ["close"], {}, 0)).toEqual({ pinned: [], recent: [] });
  });

  it("ignores pins for actions that are not available", () => {
    const noSnooze = all.filter((id) => id !== "snooze");
    expect(inlineToolbarActions(noSnooze, ["snooze", "close"], {}, 3).pinned).toEqual(["close"]);
  });
});

describe("toolbar width cap", () => {
  it("allows at most three buttons and at most half the width", () => {
    expect(maxInlineToolbarActions(null)).toBe(3);
    expect(maxInlineToolbarActions(390)).toBe(3);
    expect(maxInlineToolbarActions(1200)).toBe(3);
    expect(maxInlineToolbarActions(200)).toBe(2);
    expect(maxInlineToolbarActions(100)).toBe(1);
    expect(maxInlineToolbarActions(60)).toBe(0);
    expect(maxInlineToolbarActions(0)).toBe(0);
  });

  it("never lets n buttons exceed half the toolbar", () => {
    for (let width = 0; width <= 600; width += 7) {
      const n = maxInlineToolbarActions(width);
      expect(n * 36 + Math.max(0, n - 1) * 8).toBeLessThanOrEqual(width / 2);
    }
  });
});

describe("toolbar pin cap", () => {
  it("allows a new pin only with a free slot, and always allows unpinning", () => {
    expect(canKeepInToolbar(all, ["view", "stop"], "pin", 3)).toBe(true);
    expect(canKeepInToolbar(all, ["view", "stop", "pin"], "close", 3)).toBe(false);
    expect(canKeepInToolbar(all, ["view", "stop", "pin"], "pin", 3)).toBe(true);
    expect(togglePinnedToolbarAction(["view", "stop", "pin"], all, "close", 3)).toEqual(["view", "stop", "pin"]);
    expect(togglePinnedToolbarAction(["view", "stop", "pin"], all, "stop", 3)).toEqual(["view", "pin"]);
    expect(togglePinnedToolbarAction(["view"], all, "close", 3)).toEqual(["view", "close"]);
  });
});

describe("pin reordering", () => {
  it("moves a pin and keeps pins for unavailable actions at the end", () => {
    expect(reorderToolbarPins(["view", "stop", "pin"], all, 2, 0)).toEqual(["pin", "view", "stop"]);
    expect(reorderToolbarPins(["view", "snooze", "stop"], all.filter((id) => id !== "snooze"), 1, 0)).toEqual(["stop", "view", "snooze"]);
  });

  it("ignores out-of-range or no-op moves", () => {
    expect(reorderToolbarPins(["view", "stop"], all, 0, 5)).toEqual(["view", "stop"]);
    expect(reorderToolbarPins(["view", "stop"], all, 1, 1)).toEqual(["view", "stop"]);
    expect(reorderToolbarPins(["view", "stop"], all, -1, 0)).toEqual(["view", "stop"]);
  });

  it("maps a drag distance to the row it lands on", () => {
    expect(dragTargetIndex(0, 0, 40, 3)).toBe(0);
    expect(dragTargetIndex(0, 85, 40, 3)).toBe(2);
    expect(dragTargetIndex(2, -45, 40, 3)).toBe(1);
    expect(dragTargetIndex(1, 500, 40, 3)).toBe(2);
    expect(dragTargetIndex(1, -500, 40, 3)).toBe(0);
    expect(dragTargetIndex(1, 80, 0, 3)).toBe(1);
  });
});

describe("toolbar storage parsing", () => {
  it("falls back to empty on missing or corrupt storage", () => {
    expect(parseToolbarLastUsed(null)).toEqual({});
    expect(parseToolbarLastUsed("{nope")).toEqual({});
    expect(parseToolbarLastUsed("[1,2]")).toEqual({});
    expect(parseToolbarPins(null)).toEqual([]);
    expect(parseToolbarPins("{nope")).toEqual([]);
    expect(parseToolbarPins('{"a":1}')).toEqual([]);
  });

  it("keeps only known ids and sane timestamps", () => {
    expect(parseToolbarLastUsed('{"close":5,"bogus":9,"stop":"x","pin":-1,"view":1.5}')).toEqual({ close: 5, view: 1.5 });
    expect(parseToolbarPins('["close","bogus","close","view",3]')).toEqual(["close", "view"]);
  });
});

const item = (id: ToolbarActionId, extra: Partial<ToolbarActionItem> = {}): ToolbarActionItem => ({
  id,
  menuLabel: `Menu ${id}`,
  ariaLabel: `Inline ${id}`,
  title: `Title ${id}`,
  icon: null,
  disabled: false,
  onClick: vi.fn(),
  ...extra
});
const items = all.map((id) => item(id));

describe("toolbar rendering", () => {
  it("shows at most three inline buttons while the menu lists every action", () => {
    const inline = inlineToolbarActions(all, ["close"], { refresh: 5 }, 3);
    const toolbar = renderToStaticMarkup(
      <ToolbarInlineButtons items={items} pinnedIds={inline.pinned} recentIds={inline.recent} onRun={vi.fn()} />
    );
    expect(toolbar.match(/<button/g)).toHaveLength(3);
    expect(toolbar).toContain('aria-label="Inline close"');
    expect(toolbar).toContain('aria-label="Inline refresh"');
    expect(toolbar.indexOf("Inline close")).toBeLessThan(toolbar.indexOf("Inline refresh"));

    const menu = renderToStaticMarkup(
      <ToolbarMenuSection canKeep={() => true} items={items} pins={["close"]} onRun={vi.fn()} onTogglePin={vi.fn()} />
    );
    for (const id of all) {
      expect(menu).toContain(`Menu ${id}`);
      expect(menu).toContain(`aria-label="Keep Menu ${id} in toolbar"`);
    }
    expect(menu.match(/aria-checked="true"/g)).toHaveLength(1);
  });

  it("renders no inline buttons when no slot fits", () => {
    expect(renderToStaticMarkup(<ToolbarInlineButtons items={items} pinnedIds={[]} recentIds={[]} onRun={vi.fn()} />)).toBe("");
  });

  it("disables new pins in the menu with a hint when the toolbar is full", () => {
    const menu = renderToStaticMarkup(
      <ToolbarMenuSection canKeep={() => false} items={items} pins={["view", "stop", "pin"]} onRun={vi.fn()} onTogglePin={vi.fn()} />
    );
    expect(menu).toContain("Toolbar full, unpin one first");
    expect(menu.match(/disabled=""[^>]*role="menuitemcheckbox"/g)).toHaveLength(3);
  });
});

describe("ToolbarCustomizeSheet", () => {
  it("lists pinned rows with reorder controls and other rows with a pin button", () => {
    const html = renderToStaticMarkup(
      <ToolbarCustomizeSheet items={items} maxInline={3} pins={["stop", "view"]} onChangePins={vi.fn()} onClose={vi.fn()} />
    );
    expect(html).toContain('aria-label="Customize toolbar"');
    expect(html).toContain('aria-label="Reorder Menu stop. Drag, or use the up and down arrow keys."');
    expect(html.indexOf("Menu stop")).toBeLessThan(html.indexOf("Menu view"));
    expect(html).toContain('aria-label="Move Menu stop down"');
    expect(html).toContain('aria-label="Unpin Menu view from toolbar"');
    expect(html).toContain('aria-label="Pin Menu close to toolbar"');
    expect(html).not.toContain("Toolbar full");
  });

  it("disables the + buttons when every slot is pinned", () => {
    const html = renderToStaticMarkup(
      <ToolbarCustomizeSheet items={items} maxInline={2} pins={["stop", "view"]} onChangePins={vi.fn()} onClose={vi.fn()} />
    );
    expect(html).toContain("Toolbar full, unpin one first");
    expect(html).toMatch(/disabled="" title="Toolbar full, unpin one first"[^>]*aria-label|aria-label="Pin Menu close to toolbar" disabled=""/);
  });
});
