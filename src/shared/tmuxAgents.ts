export const TMUX_AGENT_COMMANDS = ["claude", "codex", "opencode", "pi", "hax"];

export function displayTmuxPaneCommand(command: string | undefined): string {
  const trimmed = command?.trim() ?? "";
  // Claude Code sets its process title to its version number, e.g. "2.1.288".
  return /^\d+\.\d+\.\d+$/.test(trimmed) ? "claude" : trimmed;
}

// The agent CLI running in a pane, from tmux's pane_current_command; null for shells and other tools.
export function tmuxPaneAgent(command: string | undefined): string | null {
  const name = displayTmuxPaneCommand(command).split(/[/\\]/).pop()?.replace(/\.exe$/i, "").toLowerCase() ?? "";
  return TMUX_AGENT_COMMANDS.includes(name) ? name : null;
}

// The server's process-tree agent when it sent one, else tmux's pane_current_command.
export function tmuxEntryAgent(entry: { agent?: string; currentCommand?: string }): string | null {
  return entry.agent || tmuxPaneAgent(entry.currentCommand);
}
