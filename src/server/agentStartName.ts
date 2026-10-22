import { buildTmuxRenameText } from "../shared/tmuxRename.js";
import type { AgentRowsSnapshot } from "./agentRows.js";

export const START_NAME_POLL_MS = 1000;
// agent-status needs a few refreshes to see a fresh pane; give up after this.
export const START_NAME_TIMEOUT_MS = 45_000;

export type WaitForAgentPromptOptions = {
  pane: string;
  agent: string;
  readRows: () => Promise<AgentRowsSnapshot | null>;
  sleep?: (ms: number) => Promise<void>;
  pollMs?: number;
  timeoutMs?: number;
};

export type RenameWhenReadyOptions = WaitForAgentPromptOptions & {
  name: string;
  submitText: (target: string, text: string) => Promise<void>;
};

// Resolves true once the agent's TUI waits at an empty prompt; false when it never gets there.
export async function waitForAgentPrompt(options: WaitForAgentPromptOptions): Promise<boolean> {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const pollMs = options.pollMs ?? START_NAME_POLL_MS;
  const attempts = Math.max(1, Math.ceil((options.timeoutMs ?? START_NAME_TIMEOUT_MS) / pollMs));
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const row = (await options.readRows())?.rows.get(options.pane);
    // Blocked can be a trust prompt, where /rename would answer the wrong question.
    if (row && row.kind === options.agent && (row.status === "idle" || row.status === "done")) {
      return true;
    }
    await sleep(pollMs);
  }
  return false;
}

// Types the agent's rename command once its TUI waits at an empty prompt; false when it never gets there.
export async function renameWhenReady(options: RenameWhenReadyOptions): Promise<boolean> {
  if (!await waitForAgentPrompt(options)) {
    return false;
  }
  await options.submitText(options.pane, buildTmuxRenameText(options.agent, options.name));
  return true;
}
