import { describe, expect, it } from "vitest";

import { buildTmuxTransitionNotification } from "../tmuxNotifications.js";

describe("tmux notification payloads", () => {
  it("includes the waiting tmux tab in display text and launch metadata", () => {
    expect(buildTmuxTransitionNotification("agent-demo", "Claude", "waiting-for-input")).toEqual({
      title: "agent-demo needs input",
      body: "Claude needs input in agent-demo.",
      tag: "agent-tmux-web-agent-demo",
      tmuxSession: "agent-demo"
    });
  });

  it("falls back to a generic task label without dropping the session target", () => {
    expect(buildTmuxTransitionNotification("codex", "", "waiting-for-input")).toMatchObject({
      body: "Tmux task needs input in codex.",
      tmuxSession: "codex"
    });
  });

  it("describes an idle transition without claiming input is required", () => {
    expect(buildTmuxTransitionNotification("codex", "OpenCode", "idle")).toEqual({
      title: "codex is idle",
      body: "OpenCode is idle in codex.",
      tag: "agent-tmux-web-codex",
      tmuxSession: "codex"
    });
  });

  it("shows a readable pane name while keeping the pane id as the launch target", () => {
    expect(buildTmuxTransitionNotification("%38", "Claude", "idle", "main:1.1")).toEqual({
      title: "main:1.1 is idle",
      body: "Claude is idle in main:1.1.",
      tag: "agent-tmux-web-%38",
      tmuxSession: "%38"
    });
  });
});
