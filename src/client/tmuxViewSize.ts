import { useCallback, useEffect, useRef, useState } from "react";

import { measureMonoChar } from "./tmuxOutputLines.js";

// Constant: only the width is the phone's to choose, and a stable height keeps the soft keyboard out of it.
export const TMUX_VIEW_ROWS = 50;
// Matches the server's lower clamp.
export const TMUX_VIEW_MIN_COLS = 20;
export const TMUX_VIEW_RESEND_MIN_DELTA = 2;
export const TMUX_VIEW_RESEND_DEBOUNCE_MS = 400;
export const TMUX_VIEW_RESEND_MIN_INTERVAL_MS = 2_000;
// Time for tmux to resize the window and the agent to start redrawing before the follow-up capture.
export const TMUX_VIEW_RECAPTURE_DELAY_MS = 350;

export type TmuxViewSizeRequest = { clientId: string; target: string; cols: number; rows: number; retake?: boolean };
export type TmuxViewSizeSender = (body: TmuxViewSizeRequest, options?: { keepalive?: boolean }) => Promise<{ data?: { applied?: boolean } } | undefined>;

// Whole columns of `charWidth` that fit in the output box once its horizontal padding is taken out.
export function computeViewCols(box: { clientWidth: number; paddingLeft: number; paddingRight: number; charWidth: number }): number | null {
  const usable = box.clientWidth - box.paddingLeft - box.paddingRight;
  if (!(usable > 0) || !(box.charWidth > 0)) {
    return null;
  }
  return Math.max(TMUX_VIEW_MIN_COLS, Math.floor(usable / box.charWidth));
}

export function shouldResendViewCols(sentCols: number, cols: number): boolean {
  return Math.abs(cols - sentCols) >= TMUX_VIEW_RESEND_MIN_DELTA;
}

// The pane fits the screen, so lines wrap there instead of scrolling; a wider pane (the desktop took
// the window back) keeps the sideways scroll.
export function ttyWrapsLines(paneWidth: number | null | undefined, cols: number | null): boolean {
  return typeof paneWidth === "number" && cols !== null && paneWidth <= cols;
}

export function viewWidthHintVisible(state: { settled: boolean; paneWidth: number | null | undefined; cols: number | null }): boolean {
  return state.settled && typeof state.paneWidth === "number" && state.cols !== null && state.paneWidth > state.cols;
}

export type TmuxViewSizeOptions = {
  // Phone, not demo, local pane, TTY view.
  enabled: boolean;
  target: string;
  clientId: string;
  // Changes when the output element is replaced (pane or view switch), so the width is measured again.
  measureKey: string;
  paneWidth: number | null | undefined;
  getOutput: () => HTMLElement | null;
  getShell: () => HTMLElement | null;
  send: TmuxViewSizeSender;
  recapture: (target: string) => Promise<unknown>;
};

// While a phone views a pane in TTY, asks the server to size the tmux window to the columns that fit the
// screen so the agent wraps there. Returns the measured columns and whether to hint that the window is wider.
export function useTmuxViewSize(options: TmuxViewSizeOptions): { cols: number | null; hint: boolean } {
  const { enabled, target, clientId, measureKey, paneWidth } = options;
  const [cols, setCols] = useState<number | null>(null);
  const [settled, setSettled] = useState(false);
  const live = useRef(options);
  live.current = options;
  const colsRef = useRef<number | null>(null);
  const sentRef = useRef<{ target: string; cols: number; at: number } | null>(null);
  const hasCols = cols !== null;

  const measure = useCallback(() => {
    const output = live.current.getOutput();
    if (!output) {
      return;
    }
    const style = window.getComputedStyle(output);
    const next = computeViewCols({
      clientWidth: output.clientWidth,
      paddingLeft: Number.parseFloat(style.paddingLeft) || 0,
      paddingRight: Number.parseFloat(style.paddingRight) || 0,
      charWidth: measureMonoChar(output).charWidth
    });
    if (next !== null && next !== colsRef.current) {
      colsRef.current = next;
      setCols(next);
    }
  }, []);

  useEffect(() => {
    const frame = window.requestAnimationFrame(measure);
    const shell = live.current.getShell();
    // Only a width change matters: the soft keyboard changes the height alone.
    let lastWidth = shell?.clientWidth ?? 0;
    const observer = shell && typeof ResizeObserver !== "undefined"
      ? new ResizeObserver(() => {
        if (shell.clientWidth !== lastWidth) {
          lastWidth = shell.clientWidth;
          measure();
        }
      })
      : null;
    observer?.observe(shell as Element);
    const onOrientation = () => window.requestAnimationFrame(() => window.requestAnimationFrame(measure));
    window.addEventListener("orientationchange", onOrientation);
    return () => {
      window.cancelAnimationFrame(frame);
      observer?.disconnect();
      window.removeEventListener("orientationchange", onOrientation);
    };
  }, [measure, measureKey]);

  const release = useCallback((keepalive = false) => {
    const sent = sentRef.current;
    if (!sent) {
      return;
    }
    sentRef.current = null;
    void live.current.send({ clientId: live.current.clientId, target: "", cols: sent.cols, rows: TMUX_VIEW_ROWS }, { keepalive }).catch(() => undefined);
  }, []);

  const apply = useCallback((retake: boolean) => {
    const { enabled: on, target: pane, clientId: id } = live.current;
    const width = colsRef.current;
    if (!on || !pane || width === null) {
      return;
    }
    sentRef.current = { target: pane, cols: width, at: Date.now() };
    const stillCurrent = () => live.current.enabled && live.current.target === pane;
    live.current.send({ clientId: id, target: pane, cols: width, rows: TMUX_VIEW_ROWS, retake }).catch(() => undefined).then(() => {
      if (!stillCurrent()) {
        return undefined;
      }
      return new Promise<void>((resolve) => window.setTimeout(resolve, TMUX_VIEW_RECAPTURE_DELAY_MS));
    }).then(() => (stillCurrent() ? live.current.recapture(pane) : undefined)).catch(() => undefined).then(() => {
      if (stillCurrent()) {
        setSettled(true);
      }
    });
  }, []);

  // Selecting a pane (or the first measurement arriving) takes the window; leaving TTY gives it back.
  useEffect(() => {
    if (!enabled || !target) {
      release();
      return;
    }
    setSettled(false);
    if (hasCols) {
      apply(true);
    }
  }, [apply, enabled, hasCols, release, target]);

  useEffect(() => {
    if (!enabled) {
      return;
    }
    const onVisibility = () => {
      if (!document.hidden) {
        apply(true);
      }
    };
    const onPageHide = () => release(true);
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) {
        apply(true);
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("pageshow", onPageShow);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("pageshow", onPageShow);
    };
  }, [apply, enabled, release]);

  useEffect(() => {
    const sent = sentRef.current;
    if (!enabled || !target || cols === null || !sent || sent.target !== target || !shouldResendViewCols(sent.cols, cols)) {
      return;
    }
    // The desktop took the window back: leave it until the next pane select or return to the app.
    const currentPaneWidth = live.current.paneWidth;
    if (typeof currentPaneWidth === "number" && currentPaneWidth > sent.cols) {
      return;
    }
    const wait = Math.max(TMUX_VIEW_RESEND_DEBOUNCE_MS, sent.at + TMUX_VIEW_RESEND_MIN_INTERVAL_MS - Date.now());
    const timer = window.setTimeout(() => apply(false), wait);
    return () => window.clearTimeout(timer);
  }, [apply, cols, enabled, target]);

  useEffect(() => () => release(true), [release]);

  return { cols, hint: enabled && viewWidthHintVisible({ settled, paneWidth, cols }) };
}
