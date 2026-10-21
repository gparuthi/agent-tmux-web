import { ChevronDown, ChevronUp, GripVertical, Minus, Plus, SlidersHorizontal, X } from "lucide-react";
import { useRef, useState, type KeyboardEvent, type PointerEvent } from "react";

import type { ToolbarActionItem } from "./TmuxToolbarButtons.js";
import {
  canKeepInToolbar,
  dragTargetIndex,
  reorderToolbarPins,
  togglePinnedToolbarAction,
  type ToolbarActionId
} from "./tmuxToolbarActions.js";

type Props = {
  items: ToolbarActionItem[];
  pins: readonly ToolbarActionId[];
  maxInline: number;
  onChangePins: (pins: ToolbarActionId[]) => void;
  onClose: () => void;
};

type Drag = { from: number; startY: number; rowHeight: number; offsetY: number };

export function ToolbarCustomizeSheet({ items, pins, maxInline, onChangePins, onClose }: Props) {
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const available = items.map((item) => item.id);
  const pinnedItems = pins.flatMap((id) => items.filter((item) => item.id === id));
  const otherItems = items.filter((item) => !pins.includes(item.id));
  const full = otherItems.length > 0 && !canKeepInToolbar(available, pins, otherItems[0].id, maxInline);
  const target = drag ? dragTargetIndex(drag.from, drag.offsetY, drag.rowHeight, pinnedItems.length) : -1;

  function move(from: number, to: number) {
    onChangePins(reorderToolbarPins(pins, available, from, to));
  }

  function startDrag(event: PointerEvent<HTMLButtonElement>, index: number) {
    const row = event.currentTarget.closest("li");
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const next = { from: index, startY: event.clientY, rowHeight: row?.getBoundingClientRect().height ?? 0, offsetY: 0 };
    dragRef.current = next;
    setDrag(next);
  }

  function moveDrag(event: PointerEvent<HTMLButtonElement>) {
    const current = dragRef.current;
    if (!current) {
      return;
    }
    const next = { ...current, offsetY: event.clientY - current.startY };
    dragRef.current = next;
    setDrag(next);
  }

  function endDrag(commit: boolean) {
    const current = dragRef.current;
    dragRef.current = null;
    setDrag(null);
    if (commit && current) {
      move(current.from, dragTargetIndex(current.from, current.offsetY, current.rowHeight, pinnedItems.length));
    }
  }

  function handleKey(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      event.preventDefault();
      move(index, index + (event.key === "ArrowUp" ? -1 : 1));
    }
  }

  // Rows between the grabbed row and its target slide one row to make room.
  function rowStyle(index: number) {
    if (!drag) {
      return undefined;
    }
    if (index === drag.from) {
      return { transform: `translateY(${drag.offsetY}px)`, zIndex: 2 };
    }
    if (drag.from < target && index > drag.from && index <= target) {
      return { transform: `translateY(${-drag.rowHeight}px)` };
    }
    if (drag.from > target && index < drag.from && index >= target) {
      return { transform: `translateY(${drag.rowHeight}px)` };
    }
    return undefined;
  }

  return (
    <div className="new-agent-backdrop" role="presentation" onClick={(event) => event.target === event.currentTarget && onClose()}>
      <div aria-label="Customize toolbar" aria-modal="true" className="new-agent-sheet toolbar-customize-sheet" role="dialog">
        <header className="new-agent-header">
          <strong><SlidersHorizontal aria-hidden="true" size={16} /> Customize toolbar</strong>
          <button aria-label="Close" className="new-agent-close" title="Close" type="button" onClick={onClose}><X size={16} /></button>
        </header>
        <div className="new-agent-muted">Pinned buttons come first, in this order. Recent ones fill the remaining slots (up to {maxInline}).</div>
        <div className="new-agent-label">Pinned</div>
        <ul aria-label="Pinned actions" className="toolbar-customize-list">
          {pinnedItems.length === 0 && <li className="new-agent-muted">Nothing pinned: the toolbar shows your most recent actions.</li>}
          {pinnedItems.map((item, index) => (
            <li className={drag?.from === index ? "dragging" : undefined} key={item.id} style={rowStyle(index)}>
              <button
                aria-label={`Reorder ${item.menuLabel}. Drag, or use the up and down arrow keys.`}
                className="toolbar-customize-grip"
                title="Drag to reorder"
                type="button"
                onKeyDown={(event) => handleKey(event, index)}
                onPointerCancel={() => endDrag(false)}
                onPointerDown={(event) => startDrag(event, index)}
                onPointerMove={moveDrag}
                onPointerUp={() => endDrag(true)}
              >
                <GripVertical aria-hidden="true" size={16} />
              </button>
              <span className="toolbar-customize-name">{item.icon}<span>{item.menuLabel}</span>{index >= maxInline && <small>menu only</small>}</span>
              <button aria-label={`Move ${item.menuLabel} up`} disabled={index === 0} title="Move up" type="button" onClick={() => move(index, index - 1)}>
                <ChevronUp aria-hidden="true" size={15} />
              </button>
              <button aria-label={`Move ${item.menuLabel} down`} disabled={index === pinnedItems.length - 1} title="Move down" type="button" onClick={() => move(index, index + 1)}>
                <ChevronDown aria-hidden="true" size={15} />
              </button>
              <button aria-label={`Unpin ${item.menuLabel} from toolbar`} title="Remove from toolbar" type="button" onClick={() => onChangePins(togglePinnedToolbarAction(pins, available, item.id, maxInline))}>
                <Minus aria-hidden="true" size={15} />
              </button>
            </li>
          ))}
        </ul>
        <div className="new-agent-label">Other actions</div>
        <ul aria-label="Other actions" className="toolbar-customize-list">
          {otherItems.map((item) => (
            <li key={item.id}>
              <span className="toolbar-customize-name">{item.icon}<span>{item.menuLabel}</span></span>
              <button
                aria-label={`Pin ${item.menuLabel} to toolbar`}
                disabled={full}
                title={full ? "Toolbar full, unpin one first" : "Keep in toolbar"}
                type="button"
                onClick={() => onChangePins(togglePinnedToolbarAction(pins, available, item.id, maxInline))}
              >
                <Plus aria-hidden="true" size={15} />
              </button>
            </li>
          ))}
        </ul>
        {full && <small className="toolbar-customize-hint">Toolbar full, unpin one first</small>}
      </div>
    </div>
  );
}
