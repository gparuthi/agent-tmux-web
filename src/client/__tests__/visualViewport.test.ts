import { describe, expect, it, vi } from "vitest";

import { installVisualViewportTracking, VISUAL_VIEWPORT_PROPERTIES, visualViewportFrame } from "../visualViewport.js";

// Node has no DOM; a stub window with a visualViewport EventTarget and a manual rAF queue stands in.
function stubHost({ layoutHeight = 844, height = 844, offsetTop = 0, scale = 1, scrollY = 0, visualViewport = true, activeElement = null as Element | null } = {}) {
  const viewport = Object.assign(new EventTarget(), { height, offsetTop, scale });
  const properties = new Map<string, string>();
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
  const host = Object.assign(new EventTarget(), {
    scrollX: 0,
    scrollY,
    visualViewport: visualViewport ? viewport : null,
    document: {
      activeElement,
      documentElement: {
        clientHeight: layoutHeight,
        style: {
          setProperty: (name: string, value: string) => properties.set(name, value),
          removeProperty: (name: string) => properties.delete(name)
        }
      }
    },
    scrollTo: vi.fn(() => {
      host.scrollY = 0;
    }),
    requestAnimationFrame: vi.fn((callback: FrameRequestCallback) => {
      nextFrame += 1;
      frames.set(nextFrame, callback);
      return nextFrame;
    }),
    cancelAnimationFrame: vi.fn((id: number) => frames.delete(id))
  });
  const flushFrames = () => {
    const pending = [...frames.values()];
    frames.clear();
    pending.forEach((callback) => callback(0));
  };
  return { host: host as unknown as Parameters<typeof installVisualViewportTracking>[0] & typeof host, viewport, properties, frames, flushFrames };
}

describe("visualViewportFrame", () => {
  it("reports no keyboard when the visual viewport fills the layout viewport", () => {
    expect(visualViewportFrame({ height: 844, offsetTop: 0, scale: 1 }, 844)).toEqual({ height: 844, top: 0, keyboardInset: 0 });
  });

  it("measures the keyboard as the layout viewport left below the visible area", () => {
    expect(visualViewportFrame({ height: 508, offsetTop: 0, scale: 1 }, 844)).toEqual({ height: 508, top: 0, keyboardInset: 336 });
    // iOS panned the visible area down 120px: the keyboard now covers only what is below it.
    expect(visualViewportFrame({ height: 508.4, offsetTop: 120, scale: 1 }, 844)).toEqual({ height: 508, top: 120, keyboardInset: 216 });
  });

  it("reports no keyboard inset when the layout already resized (Android resizes-content)", () => {
    expect(visualViewportFrame({ height: 500, offsetTop: 0, scale: 1 }, 500)).toEqual({ height: 500, top: 0, keyboardInset: 0 });
  });

  it("ignores pinch zoom and empty viewports", () => {
    expect(visualViewportFrame({ height: 422, offsetTop: 200, scale: 2 }, 844)).toBeNull();
    expect(visualViewportFrame({ height: 0, offsetTop: 0, scale: 1 }, 844)).toBeNull();
  });
});

describe("installVisualViewportTracking", () => {
  it("does nothing without visualViewport so CSS falls back to dvh", () => {
    const { host, properties } = stubHost({ visualViewport: false });
    const uninstall = installVisualViewportTracking(host);

    expect(properties.size).toBe(0);
    expect(() => uninstall()).not.toThrow();
  });

  it("publishes the visible height, offset and keyboard inset immediately", () => {
    const { host, properties } = stubHost();
    installVisualViewportTracking(host);

    expect(Object.fromEntries(properties)).toEqual({
      "--atw-viewport-height": "844px",
      "--atw-viewport-top": "0px",
      "--atw-keyboard-inset": "0px"
    });
  });

  it("follows the keyboard opening once per animation frame", () => {
    const { host, viewport, properties, flushFrames } = stubHost();
    installVisualViewportTracking(host);

    viewport.height = 508;
    viewport.dispatchEvent(new Event("resize"));
    viewport.dispatchEvent(new Event("resize"));
    viewport.dispatchEvent(new Event("scroll"));
    expect(host.requestAnimationFrame).toHaveBeenCalledTimes(1);
    expect(properties.get("--atw-viewport-height")).toBe("844px");

    flushFrames();
    expect(properties.get("--atw-viewport-height")).toBe("508px");
    expect(properties.get("--atw-keyboard-inset")).toBe("336px");

    viewport.height = 844;
    viewport.dispatchEvent(new Event("resize"));
    flushFrames();
    expect(properties.get("--atw-viewport-height")).toBe("844px");
    expect(properties.get("--atw-keyboard-inset")).toBe("0px");
  });

  it("tracks an iOS pan of the visual viewport", () => {
    const { host, viewport, properties, flushFrames } = stubHost();
    installVisualViewportTracking(host);

    viewport.height = 508;
    viewport.offsetTop = 90;
    viewport.dispatchEvent(new Event("scroll"));
    flushFrames();

    expect(properties.get("--atw-viewport-top")).toBe("90px");
    expect(properties.get("--atw-keyboard-inset")).toBe("246px");
  });

  it("undoes the document pan iOS applies to reveal a focused input", () => {
    const { host, viewport, flushFrames } = stubHost();
    installVisualViewportTracking(host);
    expect(host.scrollTo).not.toHaveBeenCalled();

    host.scrollY = 260;
    viewport.height = 508;
    host.dispatchEvent(new Event("scroll"));
    flushFrames();

    expect(host.scrollTo).toHaveBeenCalledWith(0, 0);
    expect(host.scrollY).toBe(0);
  });

  it("scrolls a focused sheet field back into view when the keyboard opens", () => {
    const scrollIntoView = vi.fn();
    const field = { closest: (selector: string) => selector === '[role="dialog"]' ? {} : null, scrollIntoView } as unknown as Element;
    const { host, viewport, flushFrames } = stubHost({ activeElement: field });
    installVisualViewportTracking(host);
    expect(scrollIntoView).not.toHaveBeenCalled();

    viewport.height = 508;
    viewport.dispatchEvent(new Event("resize"));
    flushFrames();
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });

    // Panning with the keyboard already up leaves the user's sheet scroll alone.
    viewport.offsetTop = 40;
    viewport.dispatchEvent(new Event("scroll"));
    flushFrames();
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it("leaves focus outside sheets alone so the composer and xterm don't scroll", () => {
    const scrollIntoView = vi.fn();
    const composer = { closest: () => null, scrollIntoView } as unknown as Element;
    const { host, viewport, flushFrames } = stubHost({ activeElement: composer });
    installVisualViewportTracking(host);

    viewport.height = 508;
    viewport.dispatchEvent(new Event("resize"));
    flushFrames();
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it("falls back to dvh while pinch-zoomed", () => {
    const { host, viewport, properties, flushFrames } = stubHost({ scrollY: 40 });
    installVisualViewportTracking(host);
    expect(host.scrollTo).toHaveBeenCalledTimes(1);

    viewport.scale = 2;
    host.scrollY = 40;
    viewport.dispatchEvent(new Event("resize"));
    flushFrames();

    expect(properties.size).toBe(0);
    expect(host.scrollTo).toHaveBeenCalledTimes(1);
  });

  it("removes listeners, pending frames and properties on cleanup", () => {
    const { host, viewport, properties, frames } = stubHost();
    const uninstall = installVisualViewportTracking(host);
    viewport.dispatchEvent(new Event("resize"));
    expect(frames.size).toBe(1);

    uninstall();
    expect(host.cancelAnimationFrame).toHaveBeenCalledWith(1);
    expect(frames.size).toBe(0);
    expect(properties.size).toBe(0);
    for (const name of VISUAL_VIEWPORT_PROPERTIES) {
      expect(properties.has(name)).toBe(false);
    }

    viewport.dispatchEvent(new Event("resize"));
    host.dispatchEvent(new Event("scroll"));
    expect(host.requestAnimationFrame).toHaveBeenCalledTimes(1);
  });
});
