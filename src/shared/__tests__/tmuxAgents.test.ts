import { describe, expect, it } from "vitest";

import { displayTmuxPaneCommand, tmuxPaneAgent } from "../tmuxAgents.js";

describe("tmux pane agents", () => {
  it("recognises agent CLIs from tmux's pane_current_command", () => {
    expect(tmuxPaneAgent("2.1.289")).toBe("claude");
    expect(tmuxPaneAgent("codex")).toBe("codex");
    expect(tmuxPaneAgent("/opt/homebrew/bin/opencode")).toBe("opencode");
    expect(tmuxPaneAgent("pi")).toBe("pi");
    expect(tmuxPaneAgent("zsh")).toBeNull();
    expect(tmuxPaneAgent("gpmonv2")).toBeNull();
    expect(tmuxPaneAgent(undefined)).toBeNull();
    expect(displayTmuxPaneCommand(" 2.1.288 ")).toBe("claude");
  });
});
