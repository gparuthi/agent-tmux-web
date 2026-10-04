export type CodexModel = {
  id: string;
  model: string;
  displayName: string;
  description: string;
  hidden: boolean;
  defaultReasoningEffort: string;
  supportedReasoningEfforts: Array<{ reasoningEffort: string; description: string }>;
  isDefault: boolean;
};

export const TMUX_CAPTURE_HISTORY_LINES = 5000;

export type CodexSkill = {
  name: string;
  description: string;
  path: string;
  enabled: boolean;
  scope?: string;
};

export type TmuxSessionDto = {
  // tmux target for every API call: a pane id like "%12" (with any shim prefix), or a session name.
  name: string;
  session?: string;
  paneId?: string;
  windowIndex?: number;
  paneIndex?: number;
  windowActive?: boolean;
  paneActive?: boolean;
  label?: string;
  windowName?: string;
  paneTitle?: string;
  // Primary text: pane title, else window name ("window · pane N" when split), else session:w.p.
  displayName?: string;
  windows: number;
  created: string;
  createdAtMs?: number;
  attached: boolean;
  viewerCount?: number;
  activityAtMs?: number;
  // Owner's last keystroke into this pane: atw sends or a real terminal client (not pane output).
  lastInputAtMs?: number;
  currentCommand?: string;
  // Agent CLI in the pane, from its process tree (local panes) or pane_current_command.
  agent?: string;
  status?: TmuxSessionStatusDto;
};

// Same five states and colours as gpmon's agents panel.
export type TmuxSessionStatusKind = "working" | "blocked" | "done" | "idle" | "unknown";

export type TmuxSessionStatusDto = {
  kind: TmuxSessionStatusKind;
  // Short tooltip text, e.g. "Needs permission", "Asking a question", "Idle 12m".
  title: string;
  // "gpmon" when read from agent-status's snapshot (what gpmon shows), "atw" for atw's own fallback heuristics.
  source?: "gpmon" | "atw";
};

export type TmuxCaptureDto = {
  session: string;
  output: string;
  outputAppend?: true;
  outputRevision?: string;
  outputUnchanged?: true;
  sidebar?: {
    kind: "opencode";
    output: string;
  };
};

export type AgentDto = {
  id: string;
  label: string;
};

export type AgentDirectoryDto = {
  path: string;
  // Home-shortened path for display.
  label: string;
  source: "pane" | "repo";
};

export type AgentsDto = {
  session: string;
  agents: AgentDto[];
  // Most recent first: live pane cwds and git repos.
  directories: AgentDirectoryDto[];
};

export type StartAgentResultDto = {
  pane: string;
  directory: string;
  windowName: string;
  sessions: TmuxSessionDto[];
};

export type TmuxToolModeDto = {
  id: string;
  label: string;
  args: string;
  defaultEnabled?: boolean;
  exclusiveGroup?: string;
  description?: string;
  dangerous?: boolean;
};

export type TmuxToolDto = {
  id: string;
  label: string;
  command: string;
  defaultSessionName: string;
  modes?: TmuxToolModeDto[];
};

export type UploadedFileDto = {
  name: string;
  reference: string;
  size: number;
  mimeType: string | null;
};

export type TmuxWatchDto = {
  session: string;
  label: string;
  startedAt: string;
};

export type TmuxWatchEvent = {
  id: number;
  session: string;
  label: string;
  state: "waiting-for-input" | "idle";
  revision: number;
  startedAt: string;
  finishedAt: string;
};

export type AppStatus = {
  environment: "development" | "production";
  bindHost: string;
  port: number;
  defaultCwd: string;
  tailscaleIp: string | null;
  tailscaleDns: string | null;
  codex: {
    connected: boolean;
    appServerUrl: string;
    initialized: boolean;
    lastError: string | null;
  };
};

export type SelectedSkill = Pick<CodexSkill, "name" | "path">;
