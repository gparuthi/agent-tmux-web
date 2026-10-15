// iOS keeps dvh at full height under the keyboard and pans the page instead, so the shell follows visualViewport.

type ViewportBox = Pick<VisualViewport, "height" | "offsetTop" | "scale">;

type ViewportHost = Pick<Window, "scrollX" | "scrollY" | "scrollTo" | "requestAnimationFrame" | "cancelAnimationFrame" | "addEventListener" | "removeEventListener"> & {
  visualViewport: (ViewportBox & Pick<VisualViewport, "addEventListener" | "removeEventListener">) | null;
  document: { documentElement: Pick<HTMLElement, "clientHeight" | "style">; activeElement: Element | null };
};

export type VisualViewportFrame = {
  // Visible height above the keyboard, in CSS px.
  height: number;
  // How far the visible area sits below the layout viewport's top.
  top: number;
  // Layout viewport covered by the keyboard; 0 when it is closed or the layout already resized.
  keyboardInset: number;
};

export const VISUAL_VIEWPORT_PROPERTIES = ["--atw-viewport-height", "--atw-viewport-top", "--atw-keyboard-inset"] as const;

// Null while pinch-zoomed: the zoomed viewport is not the space the layout should fill.
export function visualViewportFrame(viewport: ViewportBox, layoutHeight: number): VisualViewportFrame | null {
  if (Math.abs(viewport.scale - 1) > 0.01 || viewport.height <= 0) {
    return null;
  }
  const height = Math.round(viewport.height);
  const top = Math.max(0, Math.round(viewport.offsetTop));
  return { height, top, keyboardInset: Math.max(0, Math.round(layoutHeight) - height - top) };
}

export function installVisualViewportTracking(host: ViewportHost): () => void {
  const viewport = host.visualViewport;
  if (!viewport) {
    return () => {};
  }
  const root = host.document.documentElement;
  const clear = () => VISUAL_VIEWPORT_PROPERTIES.forEach((name) => root.style.removeProperty(name));
  let frame = 0;
  let keyboardInset = 0;
  const apply = () => {
    frame = 0;
    const next = visualViewportFrame(viewport, root.clientHeight);
    if (!next) {
      clear();
      keyboardInset = 0;
      return;
    }
    // Undo the document pan iOS uses to reveal a focused input; the fixed shell tracks the keyboard itself.
    if (host.scrollY !== 0 || host.scrollX !== 0) {
      host.scrollTo(0, 0);
    }
    root.style.setProperty("--atw-viewport-height", `${next.height}px`);
    root.style.setProperty("--atw-viewport-top", `${next.top}px`);
    root.style.setProperty("--atw-keyboard-inset", `${next.keyboardInset}px`);
    // A sheet that just shrank for the keyboard can hide its focused field; bring it back into view.
    const focused = host.document.activeElement;
    if (next.keyboardInset > keyboardInset && focused?.closest('[role="dialog"]')) {
      focused.scrollIntoView({ block: "nearest" });
    }
    keyboardInset = next.keyboardInset;
  };
  const schedule = () => {
    if (!frame) {
      frame = host.requestAnimationFrame(apply);
    }
  };
  apply();
  viewport.addEventListener("resize", schedule);
  viewport.addEventListener("scroll", schedule);
  host.addEventListener("scroll", schedule);
  return () => {
    if (frame) {
      host.cancelAnimationFrame(frame);
      frame = 0;
    }
    viewport.removeEventListener("resize", schedule);
    viewport.removeEventListener("scroll", schedule);
    host.removeEventListener("scroll", schedule);
    clear();
  };
}
