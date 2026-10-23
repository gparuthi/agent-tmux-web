import { readFileSync } from "node:fs";
import { join } from "node:path";

import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { readBundleId } from "../feedbackScreenshot.js";
import { FeedbackSheet } from "../FeedbackSheet.js";
import { TitleMenu } from "../TitleMenu.js";
import { createTitleLongPress, placeTitleMenu, TITLE_LONG_PRESS_MS, TITLE_LONG_PRESS_SLOP } from "../titleMenuGesture.js";

const touch = (clientX = 100, clientY = 20) => ({ pointerType: "touch", isPrimary: true, clientX, clientY });

describe("title long press", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("opens after 500ms of holding still", () => {
    const onOpen = vi.fn();
    const press = createTitleLongPress(onOpen);
    press.pointerDown(touch());
    vi.advanceTimersByTime(TITLE_LONG_PRESS_MS - 1);
    expect(onOpen).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onOpen).toHaveBeenCalledOnce();
  });

  it("tolerates 10px of wobble but not more", () => {
    const onOpen = vi.fn();
    const press = createTitleLongPress(onOpen);
    press.pointerDown(touch());
    press.pointerMove({ clientX: 100 + TITLE_LONG_PRESS_SLOP, clientY: 20 - TITLE_LONG_PRESS_SLOP });
    vi.advanceTimersByTime(TITLE_LONG_PRESS_MS);
    expect(onOpen).toHaveBeenCalledOnce();

    press.pointerDown(touch());
    press.pointerMove({ clientX: 100, clientY: 20 + TITLE_LONG_PRESS_SLOP + 1 });
    vi.advanceTimersByTime(TITLE_LONG_PRESS_MS);
    expect(onOpen).toHaveBeenCalledOnce();
  });

  it("does not open when released early or cancelled", () => {
    const onOpen = vi.fn();
    const press = createTitleLongPress(onOpen);
    press.pointerDown(touch());
    vi.advanceTimersByTime(300);
    press.cancel();
    vi.advanceTimersByTime(1000);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("ignores mouse presses and secondary pointers, which use click or right-click instead", () => {
    const onOpen = vi.fn();
    const press = createTitleLongPress(onOpen);
    press.pointerDown({ ...touch(), pointerType: "mouse" });
    press.pointerDown({ ...touch(), isPrimary: false });
    vi.advanceTimersByTime(1000);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("opens on a mouse click but not on the click that follows a touch tap", () => {
    const onOpen = vi.fn();
    const press = createTitleLongPress(onOpen);
    press.pointerDown({ ...touch(), pointerType: "mouse" });
    press.cancel();
    press.click();
    expect(onOpen).toHaveBeenCalledOnce();

    press.pointerDown(touch());
    press.cancel();
    press.click();
    expect(onOpen).toHaveBeenCalledOnce();
  });

  it("opens at once on a context menu and only once per gesture", () => {
    const onOpen = vi.fn();
    const press = createTitleLongPress(onOpen);
    press.pointerDown(touch());
    press.contextMenu();
    vi.advanceTimersByTime(1000);
    expect(onOpen).toHaveBeenCalledOnce();
  });
});

describe("placeTitleMenu", () => {
  const viewport = { width: 390, height: 844 };
  const menu = { width: 170, height: 88 };

  it("sits just below the title", () => {
    expect(placeTitleMenu({ left: 12, top: 8, bottom: 32 }, menu, viewport)).toEqual({ left: 12, top: 38 });
  });

  it("stays inside the viewport horizontally", () => {
    expect(placeTitleMenu({ left: 380, top: 8, bottom: 32 }, menu, viewport).left).toBe(390 - 170 - 8);
    expect(placeTitleMenu({ left: -20, top: 8, bottom: 32 }, menu, viewport).left).toBe(8);
  });

  it("flips above the title when there is no room below", () => {
    expect(placeTitleMenu({ left: 12, top: 800, bottom: 830 }, menu, viewport).top).toBe(800 - 6 - 88);
  });
});

describe("title menu and feedback sheet", () => {
  it("offers Send feedback and Reload app", () => {
    const html = renderToStaticMarkup(<TitleMenu anchor={{ left: 0, top: 0, bottom: 24 }} onSelect={vi.fn()} onClose={vi.fn()} />);
    expect(html).toContain('role="menu"');
    expect(html).toMatch(/role="menuitem"[^>]*>.*Send feedback<\/button>/);
    expect(html).toMatch(/role="menuitem"[^>]*>.*Reload app<\/button>/);
  });

  it("renders the sheet with the screenshot toggle on, and off when capture failed", () => {
    const shot = new Blob(["x"], { type: "image/png" });
    const withShot = renderToStaticMarkup(<FeedbackSheet paneName="Brief" screenshot={shot} send={vi.fn()} onClose={vi.fn()} />);
    expect(withShot).toContain('aria-label="Send feedback"');
    expect(withShot).toContain("Goes to the Atw session. Viewing Brief.");
    expect(withShot).toMatch(/<input[^>]*type="checkbox"[^>]*checked=""/);
    expect(withShot).toContain("Include screenshot");

    const failed = renderToStaticMarkup(<FeedbackSheet paneName="Brief" screenshot={null} screenshotError="No screenshot: timed out" send={vi.fn()} onClose={vi.fn()} />);
    expect(failed).not.toContain('checked=""');
    expect(failed).toContain("No screenshot: timed out");
  });

  it("reads the bundle name from the module script", () => {
    const doc = { querySelector: () => ({ getAttribute: () => "/assets/index-ab12cd.js" }) };
    expect(readBundleId(doc)).toBe("index-ab12cd.js");
    expect(readBundleId({ querySelector: () => null })).toBe("");
  });

  it("wires the gesture onto the title and disables the iOS callout", () => {
    const app = readFileSync(join(process.cwd(), "src/client/App.tsx"), "utf8");
    const css = readFileSync(join(process.cwd(), "src/client/styles.css"), "utf8");
    expect(app).toContain('<div className="tmux-title" {...titleMenuGesture}>');
    const titleRule = css.slice(css.indexOf(".tmux-title {"), css.indexOf("}", css.indexOf(".tmux-title {")));
    expect(titleRule).toContain("-webkit-touch-callout: none");
    expect(titleRule).toContain("user-select: none");
  });
});
