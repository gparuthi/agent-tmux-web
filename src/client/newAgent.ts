import type { AgentsDto } from "../shared/api.js";

// A typed path wins over the picked suggestion.
export function resolveNewAgentDirectory(selected: string, typed: string): string {
  return typed.trim() || selected;
}

export function defaultNewAgentSelection(agents: AgentsDto | null, lastAgentId?: string | null): { agent: string; directory: string } {
  const agentIds = agents?.agents.map((agent) => agent.id) ?? [];
  return {
    agent: lastAgentId && agentIds.includes(lastAgentId) ? lastAgentId : agentIds[0] ?? "",
    directory: agents?.directories[0]?.path ?? ""
  };
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
