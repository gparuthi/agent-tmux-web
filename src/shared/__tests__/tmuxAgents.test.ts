import { describe, expect, it } from "vitest";

import { displayTmuxPaneCommand, tmuxAgentDropsTypeAhead, tmuxAgentSupportsCompact, tmuxEntryAgent, tmuxPaneAgent } from "../tmuxAgents.js";

describe("tmux pane agents", () => {
  it("recognises agent CLIs from tmux's pane_current_command", () => {
    expect(tmuxPaneAgent("2.1.289")).toBe("claude");
    expect(tmuxPaneAgent("codex")).toBe("codex");
    expect(tmuxPaneAgent("/opt/homebrew/bin/opencode")).toBe("opencode");
    expect(tmuxPaneAgent("pi")).toBe("pi");
    expect(tmuxPaneAgent("hax")).toBe("hax");
    expect(tmuxPaneAgent("/opt/homebrew/bin/hax")).toBe("hax");
    expect(tmuxPaneAgent("haxe")).toBeNull();
    expect(tmuxPaneAgent("zsh")).toBeNull();
    expect(tmuxPaneAgent("gpmonv2")).toBeNull();
    expect(tmuxPaneAgent(undefined)).toBeNull();
    expect(displayTmuxPaneCommand(" 2.1.288 ")).toBe("claude");
  });

  it("prefers the server-detected agent and falls back to the pane command", () => {
    expect(tmuxEntryAgent({ agent: "codex", currentCommand: "node" })).toBe("codex");
    expect(tmuxEntryAgent({ currentCommand: "2.1.289" })).toBe("claude");
    expect(tmuxEntryAgent({ currentCommand: "node" })).toBeNull();
  });

  it("flags only hax as dropping input typed while a turn runs", () => {
    expect(tmuxAgentDropsTypeAhead("hax")).toBe(true);
    expect(tmuxAgentDropsTypeAhead("HAX")).toBe(true);
    for (const agent of ["claude", "codex", "pi", "opencode"]) {
      expect(tmuxAgentDropsTypeAhead(agent)).toBe(false);
    }
    expect(tmuxAgentDropsTypeAhead(null)).toBe(false);
    expect(tmuxAgentDropsTypeAhead(undefined)).toBe(false);
    expect(tmuxAgentDropsTypeAhead("")).toBe(false);
  });

  it("offers /compact only to agents that have it", () => {
    expect(["claude", "codex", "pi", "Claude"].map(tmuxAgentSupportsCompact)).toEqual([true, true, true, true]);
    expect(["hax", "opencode", "zsh", "", null, undefined].map(tmuxAgentSupportsCompact)).toEqual([false, false, false, false, false, false]);
  });
});
