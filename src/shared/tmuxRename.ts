// Slash command each agent CLI uses to name its session; agents not listed can't be renamed.
export const TMUX_RENAME_COMMANDS: Readonly<Record<string, string>> = {
  claude: "/rename",
  codex: "/rename",
  // Pi has no /rename; /name <name> sets its session display name.
  pi: "/name"
};

export const TMUX_RENAME_MAX_LENGTH = 100;

const CONTROL_PATTERN = /[\p{Cc}\u2028\u2029]+/gu;
// Bidi overrides and isolates could make the typed command read differently from what runs.
const BIDI_CONTROL_PATTERN = /[\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu;

export function tmuxRenameCommand(agent: string | null | undefined): string | null {
  return agent && Object.hasOwn(TMUX_RENAME_COMMANDS, agent) ? TMUX_RENAME_COMMANDS[agent] : null;
}

export function supportsTmuxRename(agent: string | null | undefined): boolean {
  return tmuxRenameCommand(agent) !== null;
}

// One line of printable text: control characters become spaces, so a newline can't submit early.
export function sanitizeTmuxRenameName(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  const flat = value.replace(CONTROL_PATTERN, " ").replace(BIDI_CONTROL_PATTERN, "").replace(/\s+/gu, " ").trim();
  return Array.from(flat).slice(0, TMUX_RENAME_MAX_LENGTH).join("").trim();
}

export function buildTmuxRenameText(agent: string, name: string): string {
  const command = tmuxRenameCommand(agent);
  if (!command) {
    throw new Error(`${agent} has no rename command`);
  }
  return `${command} ${name}`;
}

// The name part of an agent's pane title, for prefilling the rename prompt; "" when it has none.
export function tmuxRenamePrefill(agent: string | null | undefined, paneTitle: string | undefined): string {
  // Claude and Codex prefix the title with a status glyph or spinner frame.
  const title = (paneTitle ?? "").replace(/^[^\p{L}\p{N}]+\s+/u, "").trim();
  switch (agent) {
    case "claude":
      // Claude's title before the session has a name.
      return title === "Claude Code" ? "" : title;
    case "codex":
      // "<thread name> | <project>"; an unnamed thread shows only the project.
      return title.includes(" | ") ? title.slice(0, title.lastIndexOf(" | ")).trim() : "";
    case "pi": {
      // "π - <session name> - <project>"; an unnamed session shows "π - <project>".
      const rest = title.replace(/^π - /u, "");
      return rest !== title && rest.includes(" - ") ? rest.slice(0, rest.lastIndexOf(" - ")).trim() : "";
    }
    default:
      return "";
  }
}
