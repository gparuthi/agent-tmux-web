export type TmuxTransitionNotification = {
  title: string;
  body: string;
  tag: string;
  tmuxSession: string;
};

export function buildTmuxTransitionNotification(
  session: string,
  label: string,
  state: "waiting-for-input" | "idle",
  displayName?: string
): TmuxTransitionNotification {
  const tmuxSession = session.trim();
  const shownName = displayName?.trim() || tmuxSession;
  const taskLabel = label.trim() || "Tmux task";
  if (state === "idle") {
    return {
      title: `${shownName} is idle`,
      body: `${taskLabel} is idle in ${shownName}.`,
      tag: `agent-tmux-web-${tmuxSession}`,
      tmuxSession
    };
  }
  return {
    title: `${shownName} needs input`,
    body: `${taskLabel} needs input in ${shownName}.`,
    tag: `agent-tmux-web-${tmuxSession}`,
    tmuxSession
  };
}
