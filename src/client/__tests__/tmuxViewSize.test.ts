import { describe, expect, it } from "vitest";

import {
  computeViewCols,
  shouldResendViewCols,
  TMUX_VIEW_MIN_COLS,
  ttyWrapsLines,
  viewWidthHintVisible
} from "../tmuxViewSize.js";

describe("phone view columns", () => {
  it("counts whole columns left after the horizontal padding", () => {
    // 390px wide, 12px padding each side, 7.2px glyphs: 366 / 7.2 = 50.8
    expect(computeViewCols({ clientWidth: 390, paddingLeft: 12, paddingRight: 12, charWidth: 7.2 })).toBe(50);
    expect(computeViewCols({ clientWidth: 844, paddingLeft: 12, paddingRight: 12, charWidth: 7.2 })).toBe(113);
  });

  it("never goes below the server's minimum, and gives up on an unmeasured box", () => {
    expect(computeViewCols({ clientWidth: 100, paddingLeft: 12, paddingRight: 12, charWidth: 7.2 })).toBe(TMUX_VIEW_MIN_COLS);
    expect(computeViewCols({ clientWidth: 0, paddingLeft: 12, paddingRight: 12, charWidth: 7.2 })).toBeNull();
    expect(computeViewCols({ clientWidth: 390, paddingLeft: 12, paddingRight: 12, charWidth: 0 })).toBeNull();
  });

  it("resends only when the columns moved by two or more", () => {
    expect(shouldResendViewCols(47, 47)).toBe(false);
    expect(shouldResendViewCols(47, 48)).toBe(false);
    expect(shouldResendViewCols(47, 49)).toBe(true);
    expect(shouldResendViewCols(47, 44)).toBe(true);
  });
});

describe("TTY line wrapping switch", () => {
  it("wraps only when the pane is no wider than the phone", () => {
    expect(ttyWrapsLines(47, 47)).toBe(true);
    expect(ttyWrapsLines(40, 47)).toBe(true);
    expect(ttyWrapsLines(106, 47)).toBe(false);
  });

  it("keeps scrolling until the pane width or the measurement is known", () => {
    expect(ttyWrapsLines(undefined, 47)).toBe(false);
    expect(ttyWrapsLines(null, 47)).toBe(false);
    expect(ttyWrapsLines(47, null)).toBe(false);
  });

  it("hints about a wider window only once the first fit has settled", () => {
    expect(viewWidthHintVisible({ settled: false, paneWidth: 150, cols: 47 })).toBe(false);
    expect(viewWidthHintVisible({ settled: true, paneWidth: 150, cols: 47 })).toBe(true);
    expect(viewWidthHintVisible({ settled: true, paneWidth: 47, cols: 47 })).toBe(false);
    expect(viewWidthHintVisible({ settled: true, paneWidth: undefined, cols: 47 })).toBe(false);
  });
});
