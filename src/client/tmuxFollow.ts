export const TMUX_CAPTURE_POLL_INTERVAL_MS = 1500;
export const TMUX_SEND_FOLLOW_DELAYS_MS = [150, 700, 1600, 3200, 6500];

export type TmuxFollowState = {
  selectedTmux: string;
  terminalActive: boolean;
  documentHidden: boolean;
};

export function shouldAutoCaptureTmux({ selectedTmux, terminalActive, documentHidden }: TmuxFollowState): boolean {
  return Boolean(selectedTmux) && !terminalActive && !documentHidden;
}

// Output within this many px of the end counts as following the latest lines.
export const TMUX_BOTTOM_SLACK_PX = 24;

type TmuxScrollBox = Pick<HTMLElement, "scrollTop" | "scrollHeight" | "clientHeight">;

export function isTmuxOutputAtBottom(node: TmuxScrollBox): boolean {
  return node.scrollHeight - node.scrollTop - node.clientHeight < TMUX_BOTTOM_SLACK_PX;
}

// After the output box resizes (the keyboard opening or closing), re-pin a view that was following the
// latest lines and leave a scrolled-up one where it is. Returns the new at-bottom state, or null for a
// hidden box (an inactive OpenCode tab) whose metrics mean nothing.
export function followTmuxOutputResize(node: TmuxScrollBox, stuckToBottom: boolean): boolean | null {
  if (node.clientHeight === 0) {
    return null;
  }
  if (stuckToBottom) {
    node.scrollTop = node.scrollHeight;
    return true;
  }
  return isTmuxOutputAtBottom(node);
}
