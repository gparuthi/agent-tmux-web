import { describe, expect, it } from "vitest";

import { tmuxEntryAgent } from "../tmuxAgents.js";
import {
  buildTmuxRenameText,
  sanitizeTmuxRenameName,
  supportsTmuxRename,
  TMUX_RENAME_MAX_LENGTH,
  tmuxRenameCommand,
  tmuxRenamePrefill
} from "../tmuxRename.js";

describe("tmux rename gating", () => {
  it("offers rename only for agents with a rename slash command", () => {
    expect(tmuxRenameCommand("claude")).toBe("/rename");
    expect(tmuxRenameCommand("codex")).toBe("/rename");
    expect(tmuxRenameCommand("pi")).toBe("/name");
    for (const agent of ["opencode", "hax", "zsh", "", "constructor", "toString", "__proto__", null, undefined]) {
      expect(supportsTmuxRename(agent), String(agent)).toBe(false);
    }
  });

  it("gates on the pane's detected agent, falling back to its command", () => {
    expect(supportsTmuxRename(tmuxEntryAgent({ agent: "codex", currentCommand: "node" }))).toBe(true);
    expect(supportsTmuxRename(tmuxEntryAgent({ currentCommand: "2.1.294" }))).toBe(true);
    expect(supportsTmuxRename(tmuxEntryAgent({ currentCommand: "opencode" }))).toBe(false);
    expect(supportsTmuxRename(tmuxEntryAgent({ currentCommand: "hax" }))).toBe(false);
    expect(supportsTmuxRename(tmuxEntryAgent({ currentCommand: "zsh" }))).toBe(false);
  });

  it("builds the agent's command line", () => {
    expect(buildTmuxRenameText("claude", "atw rename")).toBe("/rename atw rename");
    expect(buildTmuxRenameText("pi", "atw rename")).toBe("/name atw rename");
    expect(() => buildTmuxRenameText("opencode", "x")).toThrow(/no rename command/);
  });
});

describe("sanitizeTmuxRenameName", () => {
  it("keeps one trimmed line of printable text", () => {
    expect(sanitizeTmuxRenameName("  Fix the build  ")).toBe("Fix the build");
    expect(sanitizeTmuxRenameName("café 🙂 naïve")).toBe("café 🙂 naïve");
    expect(sanitizeTmuxRenameName("a;b \\ $(x) `y`")).toBe("a;b \\ $(x) `y`");
  });

  it("turns newlines and control characters into single spaces", () => {
    expect(sanitizeTmuxRenameName("one\ntwo\r\nthree")).toBe("one two three");
    expect(sanitizeTmuxRenameName("tab\there")).toBe("tab here");
    expect(sanitizeTmuxRenameName("esc\u001b[31mred\u0007")).toBe("esc [31mred");
    expect(sanitizeTmuxRenameName("del\u007fc1\u0085x")).toBe("del c1 x");
    expect(sanitizeTmuxRenameName("line\u2028para\u2029end")).toBe("line para end");
    expect(sanitizeTmuxRenameName("evil\u202etxt.exe\u2066")).toBe("eviltxt.exe");
  });

  it("rejects blank and non-string input as empty", () => {
    for (const value of ["", "   ", "\n\r\t", "\u001b", "\u202e", 42, null, undefined, ["name"]]) {
      expect(sanitizeTmuxRenameName(value), JSON.stringify(value)).toBe("");
    }
  });

  it("caps the name without splitting a surrogate pair", () => {
    expect(sanitizeTmuxRenameName("x".repeat(500))).toHaveLength(TMUX_RENAME_MAX_LENGTH);
    const emoji = sanitizeTmuxRenameName("🙂".repeat(150));
    expect(Array.from(emoji)).toHaveLength(TMUX_RENAME_MAX_LENGTH);
    expect(emoji.endsWith("🙂")).toBe(true);
  });
});

describe("tmuxRenamePrefill", () => {
  it("reads the session name out of each agent's pane title", () => {
    expect(tmuxRenamePrefill("claude", "✳ Fix the build")).toBe("Fix the build");
    expect(tmuxRenamePrefill("claude", "⠂ Fix the build")).toBe("Fix the build");
    expect(tmuxRenamePrefill("claude", "✳ Claude Code")).toBe("");
    expect(tmuxRenamePrefill("codex", "codex rename probe | atwtest")).toBe("codex rename probe");
    expect(tmuxRenamePrefill("codex", "atwtest")).toBe("");
    expect(tmuxRenamePrefill("pi", "π - pi rename probe - atwtest")).toBe("pi rename probe");
    expect(tmuxRenamePrefill("pi", "π - atwtest")).toBe("");
    expect(tmuxRenamePrefill("opencode", "anything")).toBe("");
    expect(tmuxRenamePrefill("claude", undefined)).toBe("");
  });
});
