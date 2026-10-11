import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { AgentsDto } from "../../shared/api.js";
import { NewAgentSheet } from "../NewAgentSheet.js";
import {
  clearLegacyNewAgentChoice,
  defaultNewAgentSelection,
  LEGACY_NEW_AGENT_LAST_AGENT_STORAGE_KEY,
  readApiErrorMessage,
  resolveNewAgentDirectory
} from "../newAgent.js";

const agents: AgentsDto = {
  session: "main",
  agents: [{ id: "opencode", label: "OpenCode" }, { id: "claude", label: "Claude Code" }, { id: "pi", label: "pi" }],
  directories: [
    { path: "/Users/me/work/atw", label: "~/work/atw", source: "pane" },
    { path: "/Users/me/.gp", label: "~/.gp", source: "repo" }
  ]
};

const withoutClaude: AgentsDto = { ...agents, agents: agents.agents.filter((agent) => agent.id !== "claude") };

describe("new agent helpers", () => {
  it("prefers a typed path over the picked directory", () => {
    expect(resolveNewAgentDirectory("/a", "  ~/b ")).toBe("~/b");
    expect(resolveNewAgentDirectory("/a", "   ")).toBe("/a");
  });

  it("defaults to Claude when it is installed, else the first agent, and the most recent directory", () => {
    expect(defaultNewAgentSelection(agents)).toEqual({ agent: "claude", directory: "/Users/me/work/atw" });
    expect(defaultNewAgentSelection(withoutClaude)).toEqual({ agent: "opencode", directory: "/Users/me/work/atw" });
    expect(defaultNewAgentSelection({ ...agents, agents: [] })).toEqual({ agent: "", directory: "/Users/me/work/atw" });
    expect(defaultNewAgentSelection(null)).toEqual({ agent: "", directory: "" });
  });

  it("clears the last-picked agent older builds remembered", () => {
    const storage = { removeItem: vi.fn() };
    clearLegacyNewAgentChoice(storage);
    expect(storage.removeItem).toHaveBeenCalledWith(LEGACY_NEW_AGENT_LAST_AGENT_STORAGE_KEY);
    expect(LEGACY_NEW_AGENT_LAST_AGENT_STORAGE_KEY).toBe("agent-tmux-web.new-agent.last");
    expect(() => clearLegacyNewAgentChoice({ removeItem: () => { throw new Error("blocked"); } })).not.toThrow();
    expect(() => clearLegacyNewAgentChoice(null)).not.toThrow();
  });

  it("shows the server's error text", () => {
    expect(readApiErrorMessage(new Error("{\"error\":\"Directory does not exist: ~/nope\"}"))).toBe("Directory does not exist: ~/nope");
    expect(readApiErrorMessage(new Error("Bad Gateway"))).toBe("Bad Gateway");
  });
});

describe("NewAgentSheet", () => {
  function renderSheet(initialAgents: AgentsDto) {
    return renderToStaticMarkup(
      <NewAgentSheet
        initialAgents={initialAgents}
        loadAgents={vi.fn(() => new Promise<AgentsDto>(() => undefined))}
        startAgent={vi.fn()}
        onClose={vi.fn()}
        onStarted={vi.fn()}
      />
    );
  }

  it("renders agent and directory choices with Claude and the first directory selected", () => {
    const html = renderSheet(agents);
    expect(html).toContain("role=\"dialog\"");
    expect(html).toContain("aria-checked=\"true\" class=\"active\" role=\"radio\" type=\"button\">Claude Code</button>");
    expect(html).toContain("aria-checked=\"false\" class=\"\" role=\"radio\" type=\"button\">OpenCode</button>");
    expect(html).toContain("~/work/atw");
    expect(html).toContain(">open<");
    expect(html).toContain(">repo<");
    expect(html).toContain("Start Claude Code in main");
  });

  it("selects the first agent when Claude is not installed", () => {
    const html = renderSheet(withoutClaude);
    expect(html).toContain("aria-checked=\"true\" class=\"active\" role=\"radio\" type=\"button\">OpenCode</button>");
    expect(html).toContain("Start OpenCode in main");
  });
});
