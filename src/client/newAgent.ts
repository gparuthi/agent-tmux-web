import type { AgentDto, AgentsDto } from "../shared/api.js";

// A typed path wins over the picked suggestion.
export function resolveNewAgentDirectory(selected: string, typed: string): string {
  return typed.trim() || selected;
}

// Chip text for the one-row picker; the server's labels stay as they are for other consumers.
export const NEW_AGENT_SHORT_LABELS: Readonly<Record<string, string>> = { claude: "cc" };
// Behind the "more" chip unless one of them is the selected agent.
export const NEW_AGENT_HIDDEN_IDS: readonly string[] = ["opencode", "pi", "codex"];

export function newAgentChipLabel(agent: AgentDto): string {
  return Object.hasOwn(NEW_AGENT_SHORT_LABELS, agent.id) ? NEW_AGENT_SHORT_LABELS[agent.id] : agent.label;
}

// The chips for the agents row, plus whether a "more" chip is needed at all.
export function visibleNewAgents(agents: AgentDto[], selected: string, expanded: boolean): { visible: AgentDto[]; hasHidden: boolean } {
  const isHidden = (agent: AgentDto) => NEW_AGENT_HIDDEN_IDS.includes(agent.id);
  return {
    visible: agents.filter((agent) => expanded || !isHidden(agent) || agent.id === selected),
    hasHidden: agents.some(isHidden)
  };
}

// An empty name is left out so the server keeps its default window name and plain launch.
export function buildStartAgentBody(agent: string, cwd: string, name: string): { agent: string; cwd: string; name?: string } {
  const trimmed = name.trim();
  return { agent, cwd, ...(trimmed ? { name: trimmed } : {}) };
}

export const PREFERRED_NEW_AGENT_ID = "claude";
// Older builds remembered the last-picked agent here; the sheet now always starts on Claude.
export const LEGACY_NEW_AGENT_LAST_AGENT_STORAGE_KEY = "agent-tmux-web.new-agent.last";

// Claude when it is installed, otherwise the first available agent.
export function defaultNewAgentSelection(agents: AgentsDto | null): { agent: string; directory: string } {
  const agentIds = agents?.agents.map((agent) => agent.id) ?? [];
  return {
    agent: agentIds.includes(PREFERRED_NEW_AGENT_ID) ? PREFERRED_NEW_AGENT_ID : agentIds[0] ?? "",
    directory: agents?.directories[0]?.path ?? ""
  };
}

export function clearLegacyNewAgentChoice(storage: Pick<Storage, "removeItem"> | null | undefined): void {
  try {
    storage?.removeItem(LEGACY_NEW_AGENT_LAST_AGENT_STORAGE_KEY);
  } catch {
    // Private browsing can block localStorage; a stale key is harmless.
  }
}

// The api() helper throws the raw response body; surface the server's {"error": ...} text.
export function readApiErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  try {
    const parsed = JSON.parse(message) as unknown;
    if (parsed && typeof parsed === "object" && typeof (parsed as { error?: unknown }).error === "string") {
      return (parsed as { error: string }).error;
    }
  } catch {
    // Not JSON; show it as is.
  }
  return message;
}
