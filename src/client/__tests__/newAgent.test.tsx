import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { AgentsDto } from "../../shared/api.js";
import { NewAgentSheet } from "../NewAgentSheet.js";
import { defaultNewAgentSelection, readApiErrorMessage, resolveNewAgentDirectory } from "../newAgent.js";

const agents: AgentsDto = {
  session: "main",
  agents: [{ id: "opencode", label: "OpenCode" }, { id: "pi", label: "pi" }],
  directories: [
    { path: "/Users/me/work/atw", label: "~/work/atw", source: "pane" },
    { path: "/Users/me/.gp", label: "~/.gp", source: "repo" }
  ]
};

describe("new agent helpers", () => {
  it("prefers a typed path over the picked directory", () => {
    expect(resolveNewAgentDirectory("/a", "  ~/b ")).toBe("~/b");
    expect(resolveNewAgentDirectory("/a", "   ")).toBe("/a");
  });

  it("defaults to the remembered agent when it is still available, and the most recent directory", () => {
    expect(defaultNewAgentSelection(agents, "pi")).toEqual({ agent: "pi", directory: "/Users/me/work/atw" });
    expect(defaultNewAgentSelection(agents, "claude")).toEqual({ agent: "opencode", directory: "/Users/me/work/atw" });
    expect(defaultNewAgentSelection(null)).toEqual({ agent: "", directory: "" });
  });

  it("shows the server's error text", () => {
    expect(readApiErrorMessage(new Error("{\"error\":\"Directory does not exist: ~/nope\"}"))).toBe("Directory does not exist: ~/nope");
    expect(readApiErrorMessage(new Error("Bad Gateway"))).toBe("Bad Gateway");
  });
});

describe("NewAgentSheet", () => {
  it("renders agent and directory choices with the first of each selected", () => {
    const html = renderToStaticMarkup(
      <NewAgentSheet
        initialAgents={agents}
        loadAgents={vi.fn(() => new Promise<AgentsDto>(() => undefined))}
        startAgent={vi.fn()}
        onClose={vi.fn()}
        onStarted={vi.fn()}
      />
    );
    expect(html).toContain("role=\"dialog\"");
    expect(html).toContain("aria-checked=\"true\" class=\"active\" role=\"radio\" type=\"button\">OpenCode</button>");
    expect(html).toContain("~/work/atw");
    expect(html).toContain(">open<");
    expect(html).toContain(">repo<");
    expect(html).toContain("Start OpenCode in main");
  });
});
