import { Star } from "lucide-react";
import type { ReactNode } from "react";

import type { ToolbarActionId } from "./tmuxToolbarActions.js";

export type ToolbarActionItem = {
  id: ToolbarActionId;
  // Text for the "…" menu row; the inline button is icon-only and uses ariaLabel.
  menuLabel: string;
  ariaLabel: string;
  title: string;
  icon: ReactNode;
  disabled: boolean;
  className?: string;
  pressed?: boolean;
  busy?: boolean;
  onClick: () => void;
};

type InlineProps = {
  items: ToolbarActionItem[];
  pinnedIds: readonly ToolbarActionId[];
  recentIds: readonly ToolbarActionId[];
  onRun: (item: ToolbarActionItem) => void;
};

export function ToolbarInlineButtons({ items, pinnedIds, recentIds, onRun }: InlineProps) {
  const shown = [...pinnedIds, ...recentIds].flatMap((id) => items.filter((item) => item.id === id));
  return (
    <>
      {shown.map((item) => (
        <button
          aria-busy={item.busy}
          aria-label={item.ariaLabel}
          aria-pressed={item.pressed}
          className={[item.id === "view" ? "tmux-view-toggle" : "", item.id === "close" ? "tmux-close-pane-button" : "", pinnedIds.includes(item.id) ? "kept" : "", item.className ?? ""].filter(Boolean).join(" ") || undefined}
          disabled={item.disabled}
          key={item.id}
          title={item.title}
          type="button"
          onClick={() => onRun(item)}
        >
          {item.icon}
        </button>
      ))}
    </>
  );
}

type MenuProps = {
  items: ToolbarActionItem[];
  pins: readonly ToolbarActionId[];
  canKeep: (id: ToolbarActionId) => boolean;
  onRun: (item: ToolbarActionItem) => void;
  onTogglePin: (id: ToolbarActionId) => void;
};

// Lists every action, inline or not, each with a "Keep in toolbar" toggle.
export function ToolbarMenuSection({ items, pins, canKeep, onRun, onTogglePin }: MenuProps) {
  return (
    <div className="tmux-view-menu-section tmux-settings-actions tmux-toolbar-menu">
      <span>Toolbar</span>
      {items.map((item) => {
        const kept = pins.includes(item.id);
        const full = !kept && !canKeep(item.id);
        return (
          <div className="tmux-toolbar-menu-row" key={item.id}>
            <button disabled={item.disabled} role="menuitem" title={item.title} type="button" onClick={() => onRun(item)}>
              {item.icon}
              <span>{item.menuLabel}</span>
            </button>
            <button
              aria-checked={kept}
              aria-label={`Keep ${item.menuLabel} in toolbar`}
              className={kept ? "active" : ""}
              disabled={full}
              role="menuitemcheckbox"
              title={full ? "Toolbar full, unpin one first" : "Keep in toolbar"}
              type="button"
              onClick={() => onTogglePin(item.id)}
            >
              <Star aria-hidden="true" fill={kept ? "currentColor" : "none"} size={15} />
            </button>
          </div>
        );
      })}
      {items.some((item) => !pins.includes(item.id) && !canKeep(item.id)) && (
        <small className="tmux-toolbar-menu-hint">Toolbar full, unpin one first</small>
      )}
    </div>
  );
}
