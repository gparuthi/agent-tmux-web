import { MessageSquare, RefreshCw } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { placeTitleMenu, type TitleMenuAnchor } from "./titleMenuGesture.js";

export type TitleMenuAction = "feedback" | "reload";

type TitleMenuProps = {
  anchor: TitleMenuAnchor;
  onSelect: (action: TitleMenuAction) => void;
  onClose: () => void;
};

export function TitleMenu({ anchor, onSelect, onClose }: TitleMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (menu) {
      setPosition(placeTitleMenu(anchor, { width: menu.offsetWidth, height: menu.offsetHeight }, {
        width: document.documentElement.clientWidth,
        height: window.innerHeight
      }));
    }
  }, [anchor]);

  // Focus waits for the menu to be visible; a hidden element cannot take it.
  useEffect(() => {
    if (position) {
      menuRef.current?.querySelector("button")?.focus({ preventScroll: true });
    }
  }, [position !== null]);

  useEffect(() => {
    const closeOnOutside = (event: globalThis.PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) {
        onClose();
      }
    };
    document.addEventListener("pointerdown", closeOnOutside, true);
    window.addEventListener("resize", onClose);
    window.addEventListener("blur", onClose);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutside, true);
      window.removeEventListener("resize", onClose);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);

  function onKeyDown(event: React.KeyboardEvent) {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") {
      return;
    }
    const items = Array.from(menuRef.current?.querySelectorAll("button") ?? []);
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === "ArrowDown" ? (index + 1) % items.length : (index - 1 + items.length) % items.length;
    event.preventDefault();
    items[next]?.focus();
  }

  return (
    <div
      aria-label="App menu"
      className="title-menu"
      ref={menuRef}
      role="menu"
      style={position ? { left: position.left, top: position.top } : { visibility: "hidden" }}
      onKeyDown={onKeyDown}
    >
      <button role="menuitem" type="button" onClick={() => onSelect("feedback")}><MessageSquare aria-hidden="true" size={15} /> Send feedback</button>
      <button role="menuitem" type="button" onClick={() => onSelect("reload")}><RefreshCw aria-hidden="true" size={15} /> Reload app</button>
    </div>
  );
}
