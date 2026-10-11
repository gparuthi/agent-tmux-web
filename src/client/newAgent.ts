import type { AgentsDto } from "../shared/api.js";

// A typed path wins over the picked suggestion.
export function resolveNewAgentDirectory(selected: string, typed: string): string {
  return typed.trim() || selected;
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
