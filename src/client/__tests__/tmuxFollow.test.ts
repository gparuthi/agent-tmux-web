import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  followTmuxOutputResize,
  isTmuxOutputAtBottom,
  shouldAutoCaptureTmux,
  TMUX_CAPTURE_POLL_INTERVAL_MS,
  TMUX_SEND_FOLLOW_DELAYS_MS
} from "../tmuxFollow.js";

// 2000px of output in a 600px box scrolled to its end; the keyboard then takes 300px.
function scrollBox(scrollTop: number, clientHeight: number, scrollHeight = 2000) {
  return { scrollTop, clientHeight, scrollHeight };
}

describe("tmux follow behavior", () => {
  it("polls captured tmux output only when a capture pane is visible", () => {
    expect(shouldAutoCaptureTmux({ selectedTmux: "codex", terminalActive: false, documentHidden: false })).toBe(true);
    expect(shouldAutoCaptureTmux({ selectedTmux: "", terminalActive: false, documentHidden: false })).toBe(false);
    expect(shouldAutoCaptureTmux({ selectedTmux: "codex", terminalActive: true, documentHidden: false })).toBe(false);
    expect(shouldAutoCaptureTmux({ selectedTmux: "codex", terminalActive: false, documentHidden: true })).toBe(false);
  });

  it("uses frequent follow-up captures after sending input", () => {
    expect(TMUX_CAPTURE_POLL_INTERVAL_MS).toBeLessThanOrEqual(1500);
    expect(TMUX_SEND_FOLLOW_DELAYS_MS[0]).toBeLessThanOrEqual(300);
    expect(TMUX_SEND_FOLLOW_DELAYS_MS.at(-1)).toBeGreaterThanOrEqual(5000);
  });
});

describe("tmux output resize follow", () => {
  it("treats output within the slack of its end as at the bottom", () => {
    expect(isTmuxOutputAtBottom(scrollBox(1400, 600))).toBe(true);
    expect(isTmuxOutputAtBottom(scrollBox(1380, 600))).toBe(true);
    expect(isTmuxOutputAtBottom(scrollBox(1376, 600))).toBe(false);
  });

  it("keeps output that was following the latest lines at the bottom when the keyboard opens", () => {
    const node = scrollBox(1400, 300);

    expect(followTmuxOutputResize(node, true)).toBe(true);
    expect(node.scrollTop).toBe(2000);
  });

  it("leaves a scrolled-up position alone when the keyboard opens", () => {
    const node = scrollBox(500, 300);

    expect(followTmuxOutputResize(node, false)).toBe(false);
    expect(node.scrollTop).toBe(500);
  });

  it("recomputes the jump-to-latest state when the keyboard closes", () => {
    // Scrolled up 250px with the keyboard open; closing it reveals the end without moving the scroll.
    const node = scrollBox(1450, 600);

    expect(followTmuxOutputResize(node, false)).toBe(true);
    expect(node.scrollTop).toBe(1450);
    expect(followTmuxOutputResize(scrollBox(900, 600), false)).toBe(false);
  });

  it("ignores a hidden output box so an inactive pane keeps its follow state", () => {
    const node = scrollBox(0, 0, 0);

    expect(followTmuxOutputResize(node, false)).toBeNull();
    expect(followTmuxOutputResize(node, true)).toBeNull();
    expect(node.scrollTop).toBe(0);
  });

  it("follows resizes of the capture shell in the app", () => {
    const app = readFileSync(join(process.cwd(), "src/client/App.tsx"), "utf8");

    expect(app).toMatch(/const shell = tmuxCaptureWidthRef\.current;[\s\S]{0,120}new ResizeObserver\(/);
    expect(app).toContain("followTmuxOutputResize(node, tmuxStickToBottomRef.current)");
    expect(app).toContain("const atBottom = isTmuxOutputAtBottom(node);");
  });
});
