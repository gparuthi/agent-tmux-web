export type TerminalSize = {
  cols: number;
  rows: number;
};

export type TmuxAttachOptions = {
  ignoreSize?: boolean;
};

// atw never runs resize-window for raw terminals: tmux sizes the window from its clients (window-size latest).
export type BrowserRawTerminalPolicy = {
  attachOptions: TmuxAttachOptions;
};

// Grouped sessions created for browser raw terminals; hidden from listings and swept on startup.
export const TMUX_RAW_SESSION_PREFIX = "atw-raw-";

// baseSession may carry a shim routing prefix; rawSession, windowId and paneId are names inside that tmux server.
export type TmuxGroupedAttachTarget = {
  baseSession: string;
  rawSession: string;
  windowId?: string;
  paneId?: string;
};

export function buildBrowserRawTerminalPolicy(context: { hasAttachedClients: boolean; windowViewedByOtherClients?: boolean }): BrowserRawTerminalPolicy {
  // Never resize a window another client is looking at; the browser gets that client's size instead.
  if (context.windowViewedByOtherClients) {
    return { attachOptions: { ignoreSize: true } };
  }
  return { attachOptions: {} };
}

export function buildScriptArgsForShellCommand(command: string, platform: NodeJS.Platform = process.platform): string[] {
  // BSD script (macOS) lacks -f/-e/-c; -F flushes and the command follows the file.
  if (platform === "darwin") return ["-qF", "/dev/null", "sh", "-c", command];
  return ["-qfec", command, "/dev/null"];
}

export function buildScriptArgsForTmuxAttach(
  session: string,
  options: TmuxAttachOptions = {},
  size?: TerminalSize,
  platform: NodeJS.Platform = process.platform
): string[] {
  return buildScriptArgsForShellCommand(buildTmuxAttachShellCommand(session, options, size), platform);
}

export function buildScriptSpawn(command: string, platform: NodeJS.Platform = process.platform): { file: string; args: string[] } {
  const scriptArgs = buildScriptArgsForShellCommand(command, platform);
  // BSD script aborts when stdin is a socket, which node's stdio pipes are; bash hands it a real pipe.
  if (platform === "darwin") return { file: "/bin/bash", args: ["-c", 'exec script "$@" < <(exec cat)', "atw-script", ...scriptArgs] };
  return { file: "script", args: scriptArgs };
}

// Grouped session keeps desktop clients on their window; active-pane avoids moving the shared active pane.
export function buildTmuxGroupedAttachShellCommand(
  target: TmuxGroupedAttachTarget,
  options: TmuxAttachOptions = {},
  size?: TerminalSize
): string {
  const flags = ["active-pane", ...(options.ignoreSize ? ["ignore-size"] : [])].join(",");
  const commands = [
    `tmux new-session -f ${flags} -t ${shellQuote(target.baseSession)} -s ${shellQuote(target.rawSession)}`,
    `set-option -t ${shellQuote(target.rawSession)} destroy-unattached on`,
    ...(target.windowId ? [`select-window -t ${shellQuote(`${target.rawSession}:${target.windowId}`)}`] : []),
    ...(target.paneId ? [`select-pane -t ${shellQuote(target.paneId)}`] : [])
  ];
  const command = commands.join(" ';' ");
  return size ? `stty cols ${size.cols} rows ${size.rows}; ${command}` : command;
}

export function isTmuxRawSessionName(name: string): boolean {
  return new RegExp(`(?:^|--)${TMUX_RAW_SESSION_PREFIX}[A-Za-z0-9]+$`).test(name);
}

export function buildTmuxAttachShellCommand(session: string, options: TmuxAttachOptions = {}, size?: TerminalSize): string {
  const attachCommand = `tmux attach-session${options.ignoreSize ? " -f ignore-size" : ""} -t ${shellQuote(session)}`;
  if (!size) {
    return attachCommand;
  }
  return `stty cols ${size.cols} rows ${size.rows}; ${attachCommand}`;
}

export function buildProcessTtyListArgs(): string[] {
  return ["-A", "-o", "pid=,ppid=,tty="];
}

// The raw client's pty: a descendant of the script process on a terminal script did not inherit from atw.
export function findRawTerminalPtyTty(psOutput: string, scriptPid: number): string | null {
  const rows = psOutput.split(/\r?\n/).map((line) => line.trim().split(/\s+/)).filter((row) => row.length >= 3);
  const ttyOf = new Map(rows.map(([pid, , tty]) => [pid, tty]));
  const inheritedTty = ttyOf.get(String(scriptPid));
  const tree = new Set([String(scriptPid)]);
  for (let grew = true; grew;) {
    grew = false;
    for (const [pid, ppid, tty] of rows) {
      if (tree.has(pid) || !tree.has(ppid)) {
        continue;
      }
      tree.add(pid);
      grew = true;
      // ps prints "??" (macOS) or "?" (Linux) for processes without a terminal.
      if (/^[A-Za-z0-9/]+$/.test(tty) && tty !== inheritedTty) {
        return `/dev/${tty}`;
      }
    }
  }
  return null;
}

// Resizing the raw client's pty is a client resize to tmux; resize-window would pin the window instead.
export function buildPtyResizeArgs(tty: string, size: TerminalSize, platform: NodeJS.Platform = process.platform): string[] {
  return [platform === "darwin" ? "-f" : "-F", tty, "cols", String(size.cols), "rows", String(size.rows)];
}

export function normalizeTerminalSize(cols: unknown, rows: unknown): TerminalSize {
  return {
    cols: clamp(toInteger(cols, 80), 20, 240),
    rows: clamp(toInteger(rows, 24), 8, 80)
  };
}

function toInteger(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function shellQuote(value: string): string {
  return /^[A-Za-z0-9_./:=@+-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`;
}
