import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { AgentsDto } from "../../shared/api.js";
import { NewAgentSheet } from "../NewAgentSheet.js";
import {
  buildStartAgentBody,
  clearLegacyNewAgentChoice,
  defaultNewAgentSelection,
  LEGACY_NEW_AGENT_LAST_AGENT_STORAGE_KEY,
  newAgentChipLabel,
  readApiErrorMessage,
  resolveNewAgentDirectory,
  visibleNewAgents
} from "../newAgent.js";

const agents: AgentsDto = {
  session: "main",
  agents: [{ id: "opencode", label: "OpenCode" }, { id: "claude", label: "Claude Code" }, { id: "pi", label: "pi" }],
  directories: [
    { path: "/Users/me/work/atw", label: "~/work/atw", source: "pane" },
    { path: "/Users/me/.gp", label: "~/.gp", source: "repo" }
  ]
};

const allAgents: AgentsDto["agents"] = [
  { id: "claude", label: "Claude Code" },
  { id: "hax", label: "hax" },
  { id: "opencode", label: "OpenCode" },
  { id: "pi", label: "pi" },
  { id: "codex", label: "Codex" }
];

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

  it("shortens Claude Code to cc and keeps other labels", () => {
    expect(newAgentChipLabel({ id: "claude", label: "Claude Code" })).toBe("cc");
    expect(newAgentChipLabel({ id: "hax", label: "hax" })).toBe("hax");
    expect(newAgentChipLabel({ id: "codex", label: "Codex" })).toBe("Codex");
  });

  it("hides OpenCode, pi and Codex unless expanded or selected", () => {
    const ids = (selected: string, expanded: boolean) => visibleNewAgents(allAgents, selected, expanded).visible.map((entry) => entry.id);
    expect(ids("claude", false)).toEqual(["claude", "hax"]);
    expect(ids("pi", false)).toEqual(["claude", "hax", "pi"]);
    expect(ids("claude", true)).toEqual(["claude", "hax", "opencode", "pi", "codex"]);
    expect(visibleNewAgents(allAgents, "claude", false).hasHidden).toBe(true);
    expect(visibleNewAgents(allAgents.slice(0, 2), "claude", false)).toMatchObject({ hasHidden: false });
  });

  it("sends the session name only when one is typed", () => {
    expect(buildStartAgentBody("claude", "/a", "  fix auth ")).toEqual({ agent: "claude", cwd: "/a", name: "fix auth" });
    expect(buildStartAgentBody("claude", "/a", "   ")).toEqual({ agent: "claude", cwd: "/a" });
    expect(Object.keys(buildStartAgentBody("pi", "/a", ""))).toEqual(["agent", "cwd"]);
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

  it("renders one agents row with cc selected, OpenCode and pi behind the more chip, and a name box", () => {
    const html = renderSheet(agents);
    expect(html).toContain("role=\"dialog\"");
    expect(html).toContain("aria-checked=\"true\" aria-label=\"Claude Code\" class=\"active\" role=\"radio\" title=\"Claude Code\" type=\"button\">cc</button>");
    expect(html).not.toContain(">OpenCode</button>");
    expect(html).not.toContain(">pi</button>");
    expect(html).toContain("aria-label=\"More agents\"");
    expect(html).toContain("aria-label=\"Session name\"");
    expect(html).toContain("placeholder=\"Name (optional)\"");
    expect(html).toContain("~/work/atw");
    expect(html).toContain(">open<");
    expect(html).toContain(">repo<");
    expect(html).toContain("Start Claude Code in main");
  });

  it("keeps hax visible and omits the more chip when nothing is hidden", () => {
    const html = renderSheet({ ...agents, agents: allAgents.slice(0, 2) });
    expect(html).toContain(">hax</button>");
    expect(html).not.toContain("More agents");
  });

  it("shows the selected agent even when it is normally hidden", () => {
    const html = renderSheet(withoutClaude);
    expect(html).toContain("aria-checked=\"true\" aria-label=\"OpenCode\" class=\"active\" role=\"radio\" title=\"OpenCode\" type=\"button\">OpenCode</button>");
    expect(html).not.toContain(">pi</button>");
    expect(html).toContain("Start OpenCode in main");
  });
});
