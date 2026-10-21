export type ToolbarActionId = "view" | "stop" | "pin" | "refresh" | "close" | "snooze";
export type ToolbarLastUsed = Partial<Record<ToolbarActionId, number>>;

// Today's left-to-right order; it is also the tie-break when there is no use history.
export const TOOLBAR_ACTION_ORDER: readonly ToolbarActionId[] = ["view", "stop", "pin", "refresh", "close", "snooze"];
export const TOOLBAR_LAST_USED_STORAGE_KEY = "agent-tmux-web.toolbar-last-used";
export const TOOLBAR_PINNED_STORAGE_KEY = "agent-tmux-web.toolbar-pinned";
export const MAX_INLINE_TOOLBAR_ACTIONS = 3;
// Inline buttons may use at most half the toolbar so the pane title keeps the rest.
export const TOOLBAR_INLINE_WIDTH_SHARE = 0.5;
export const TOOLBAR_BUTTON_WIDTH_PX = 36;
export const TOOLBAR_BUTTON_GAP_PX = 8;

export function isToolbarActionId(value: unknown): value is ToolbarActionId {
  return typeof value === "string" && (TOOLBAR_ACTION_ORDER as readonly string[]).includes(value);
}

export function parseToolbarLastUsed(serialized: string | null): ToolbarLastUsed {
  if (!serialized) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(serialized);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const lastUsed: ToolbarLastUsed = {};
    for (const [id, timestamp] of Object.entries(parsed)) {
      if (isToolbarActionId(id) && typeof timestamp === "number" && Number.isFinite(timestamp) && timestamp > 0) {
        lastUsed[id] = timestamp;
      }
    }
    return lastUsed;
  } catch {
    return {};
  }
}

export function parseToolbarPins(serialized: string | null): ToolbarActionId[] {
  if (!serialized) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(serialized);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return [...new Set(parsed.filter(isToolbarActionId))];
  } catch {
    return [];
  }
}

// Most recently used first, then today's order; pinned actions are not recents.
export function recentToolbarActions(
  available: readonly ToolbarActionId[],
  pins: readonly ToolbarActionId[],
  lastUsed: ToolbarLastUsed
): ToolbarActionId[] {
  return available
    .filter((id) => !pins.includes(id))
    .sort((a, b) => (lastUsed[b] ?? 0) - (lastUsed[a] ?? 0) || TOOLBAR_ACTION_ORDER.indexOf(a) - TOOLBAR_ACTION_ORDER.indexOf(b));
}

// How many buttons fit in the inline share of the toolbar, capped at three.
export function maxInlineToolbarActions(toolbarWidthPx: number | null): number {
  if (toolbarWidthPx === null || !Number.isFinite(toolbarWidthPx)) {
    return MAX_INLINE_TOOLBAR_ACTIONS;
  }
  const budget = toolbarWidthPx * TOOLBAR_INLINE_WIDTH_SHARE;
  const fit = Math.floor((budget + TOOLBAR_BUTTON_GAP_PX) / (TOOLBAR_BUTTON_WIDTH_PX + TOOLBAR_BUTTON_GAP_PX));
  return Math.max(0, Math.min(MAX_INLINE_TOOLBAR_ACTIONS, fit));
}

export type InlineToolbarActions = { pinned: ToolbarActionId[]; recent: ToolbarActionId[] };

// Slots work like a car dashboard: pins take slots first (pin order, stable), recents fill the rest.
export function inlineToolbarActions(
  available: readonly ToolbarActionId[],
  pins: readonly ToolbarActionId[],
  lastUsed: ToolbarLastUsed,
  maxInline: number
): InlineToolbarActions {
  const slots = Math.max(0, maxInline);
  const pinned = pins.filter((id) => available.includes(id)).slice(0, slots);
  // Recents keep today's order so they don't jump under a thumb; only the chosen set follows use.
  const chosen = recentToolbarActions(available, pins, lastUsed).slice(0, slots - pinned.length);
  return { pinned, recent: TOOLBAR_ACTION_ORDER.filter((id) => chosen.includes(id)) };
}

// Unpinning is always allowed; a new pin needs a free slot.
export function canKeepInToolbar(
  available: readonly ToolbarActionId[],
  pins: readonly ToolbarActionId[],
  id: ToolbarActionId,
  maxInline: number
): boolean {
  return pins.includes(id) || pins.filter((pin) => available.includes(pin)).length < maxInline;
}

// Moves one visible pin to a new place in the pin order; pins for unavailable actions keep their spot at the end.
export function reorderToolbarPins(
  pins: readonly ToolbarActionId[],
  available: readonly ToolbarActionId[],
  from: number,
  to: number
): ToolbarActionId[] {
  const visible = pins.filter((id) => available.includes(id));
  const hidden = pins.filter((id) => !available.includes(id));
  if (from < 0 || from >= visible.length || to < 0 || to >= visible.length || from === to) {
    return [...pins];
  }
  const [moved] = visible.splice(from, 1);
  visible.splice(to, 0, moved);
  return [...visible, ...hidden];
}

// Row a dragged pin lands on after moving offsetY pixels from its start.
export function dragTargetIndex(from: number, offsetY: number, rowHeight: number, count: number): number {
  if (rowHeight <= 0 || count <= 0) {
    return from;
  }
  return Math.max(0, Math.min(count - 1, from + Math.round(offsetY / rowHeight)));
}

// Adds a pin at the end (a free slot is required) or removes it.
export function togglePinnedToolbarAction(
  pins: readonly ToolbarActionId[],
  available: readonly ToolbarActionId[],
  id: ToolbarActionId,
  maxInline: number
): ToolbarActionId[] {
  if (pins.includes(id)) {
    return pins.filter((pin) => pin !== id);
  }
  return canKeepInToolbar(available, pins, id, maxInline) ? [...pins, id] : [...pins];
}
