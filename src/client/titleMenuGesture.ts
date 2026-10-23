import { useCallback, useEffect, useRef, type PointerEvent, type MouseEvent } from "react";

export const TITLE_LONG_PRESS_MS = 500;
export const TITLE_LONG_PRESS_SLOP = 10;
const MENU_MARGIN = 8;
const MENU_GAP = 6;

export type TitleMenuAnchor = { left: number; top: number; bottom: number };

export type TitleLongPress = {
  // Mouse users click or right-click; touch and pen long-press (a tap would fight scrolling).
  pointerDown: (press: { pointerType: string; isPrimary: boolean; clientX: number; clientY: number }) => void;
  pointerMove: (point: { clientX: number; clientY: number }) => void;
  cancel: () => void;
  click: () => void;
  contextMenu: () => void;
};

// onOpen fires once per gesture: a long press or a right-click, whichever comes first.
export function createTitleLongPress(onOpen: () => void): TitleLongPress {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let startX = 0;
  let startY = 0;
  let lastPointerType = "";

  const cancel = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  return {
    pointerDown({ pointerType, isPrimary, clientX, clientY }) {
      cancel();
      lastPointerType = pointerType;
      if (pointerType === "mouse" || !isPrimary) {
        return;
      }
      startX = clientX;
      startY = clientY;
      timer = setTimeout(() => {
        timer = null;
        onOpen();
      }, TITLE_LONG_PRESS_MS);
    },
    pointerMove({ clientX, clientY }) {
      if (timer !== null && (Math.abs(clientX - startX) > TITLE_LONG_PRESS_SLOP || Math.abs(clientY - startY) > TITLE_LONG_PRESS_SLOP)) {
        cancel();
      }
    },
    cancel,
    // The click after a touch tap stays inert: on phones only the long press opens the menu.
    click() {
      if (lastPointerType === "mouse") {
        onOpen();
      }
    },
    contextMenu() {
      cancel();
      onOpen();
    }
  };
}

// Pointer and context-menu handlers for the title element; onOpen gets the title's box.
export function useTitleMenuGesture(onOpen: (anchor: TitleMenuAnchor) => void) {
  const anchorRef = useRef<Element | null>(null);
  const onOpenRef = useRef(onOpen);
  onOpenRef.current = onOpen;
  const pressRef = useRef<TitleLongPress | null>(null);
  if (pressRef.current === null) {
    pressRef.current = createTitleLongPress(() => {
      const box = anchorRef.current?.getBoundingClientRect();
      if (box) {
        onOpenRef.current({ left: box.left, top: box.top, bottom: box.bottom });
      }
    });
  }
  const press = pressRef.current;
  useEffect(() => press.cancel, [press]);

  return {
    onPointerDown: useCallback((event: PointerEvent<HTMLElement>) => {
      anchorRef.current = event.currentTarget;
      press.pointerDown(event);
    }, [press]),
    onPointerMove: useCallback((event: PointerEvent<HTMLElement>) => press.pointerMove(event), [press]),
    onPointerUp: press.cancel,
    onPointerCancel: press.cancel,
    onClick: useCallback((event: MouseEvent<HTMLElement>) => {
      anchorRef.current = event.currentTarget;
      press.click();
    }, [press]),
    onContextMenu: useCallback((event: MouseEvent<HTMLElement>) => {
      event.preventDefault();
      anchorRef.current = event.currentTarget;
      press.contextMenu();
    }, [press])
  };
}

// Below the title, flipped above it when that does not fit, always inside the viewport.
export function placeTitleMenu(
  anchor: TitleMenuAnchor,
  menu: { width: number; height: number },
  viewport: { width: number; height: number }
): { left: number; top: number } {
  const left = Math.max(MENU_MARGIN, Math.min(anchor.left, viewport.width - menu.width - MENU_MARGIN));
  let top = anchor.bottom + MENU_GAP;
  if (top + menu.height > viewport.height - MENU_MARGIN && anchor.top - MENU_GAP - menu.height >= MENU_MARGIN) {
    top = anchor.top - MENU_GAP - menu.height;
  }
  top = Math.max(MENU_MARGIN, Math.min(top, viewport.height - menu.height - MENU_MARGIN));
  return { left, top };
}
