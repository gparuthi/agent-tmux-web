import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import stringWidth from "string-width";

import {
  TMUX_CAPTURE_HISTORY_LINES,
  type TmuxSessionStatusDto,
  type TmuxToolDto
} from "../shared/api.js";
import { displayTmuxPaneCommand } from "../shared/tmuxAgents.js";
import { tmuxStatus } from "../shared/tmuxStatus.js";
import { buildTmuxToolCommand, DEFAULT_TMUX_TOOLS } from "../shared/tmuxTools.js";
import { isTmuxRawSessionName } from "./terminal.js";

export { buildTmuxToolCommand } from "../shared/tmuxTools.js";
export { displayTmuxPaneCommand } from "../shared/tmuxAgents.js";

const execFileAsync = promisify(execFile);

export type TmuxSession = {
  // Target for tmux -t: the pane id (%N, plus any shim prefix) for pane rows, the session name for legacy rows.
  name: string;
  session?: string;
  paneId?: string;
  windowId?: string;
  windowIndex?: number;
  paneIndex?: number;
  windowActive?: boolean;
  paneActive?: boolean;
  label?: string;
  windowName?: string;
  displayName?: string;
  windows: number;
  created: string;
  createdAtMs?: number;
  attached: boolean;
  clientCount: number;
  panePid?: number;
  currentPath?: string;
  activityAtMs?: number;
  currentCommand?: string;
  paneTitle?: string;
  snoozedUntilMs?: number;
};

export type CodexTmuxCommandOptions = {
  cwd: string;
  model?: string | null;
};

export type TmuxToolConfig = TmuxToolDto;

export type TmuxPaneMetadata = {
  currentCommand: string;
  width: number;
  height: number;
  alternateScreen: boolean;
  panePid?: number;
  currentPath?: string;
  paneTitle?: string;
};

type TmuxPaneView = {
  output: string;
  outputAppend?: true;
  outputRevision?: string;
  outputUnchanged?: true;
  sidebar?: {
    kind: "opencode";
    output: string;
  };
};

export type TmuxPaneCapture = TmuxPaneView;

export type TmuxSubmitKey = "enter" | "codex-enter" | "tab";
export type TmuxInterruptKey = "escape" | "ctrl-c";

const DEFAULT_DETACHED_TMUX_COLS = 160;
const DEFAULT_DETACHED_TMUX_ROWS = 40;
export const TMUX_LITERAL_SEND_CHUNK_SIZE = 16_000;
const MIN_TMUX_CAPTURE_LINES = 20;
const TMUX_CAPTURE_MAX_BUFFER_BYTES = 8 * 1024 * 1024;
const OPENCODE_SESSION_CACHE_MS = 30_000;
const OPENCODE_TEXT_CACHE_LIMIT = 100;
const OPENCODE_TEXT_CACHE_MAX_BYTES = 8 * 1024 * 1024;

type OpenCodePaneSessionCacheEntry = {
  currentPath?: string;
  expiresAt: number;
  panePid: number;
  paneTitle?: string;
  sessionId: string;
};

type OpenCodeTextCacheEntry = {
  output: string | null;
  revision: string;
  sizeBytes: number;
};

const openCodePaneSessionCache = new Map<string, OpenCodePaneSessionCacheEntry>();
const openCodeTextCache = new Map<string, OpenCodeTextCacheEntry>();
let openCodeTextCacheBytes = 0;

export function normalizeTmuxSessionName(name: string): string {
  const normalized = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);

  return normalized || "codex";
}

export function normalizeTmuxToolId(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

function parseTmuxToolModes(value: unknown): NonNullable<TmuxToolConfig["modes"]> {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry, index) => {
    if (!entry || typeof entry !== "object") {
      return [];
    }
    const record = entry as Record<string, unknown>;
    if (typeof record.args !== "string") {
      return [];
    }
    const args = record.args.trim();
    const label = typeof record.label === "string" && record.label.trim() ? record.label.trim() : `Mode ${index + 1}`;
    const id = normalizeTmuxToolId(typeof record.id === "string" ? record.id : label) || `mode-${index + 1}`;
    const exclusiveGroup = normalizeTmuxToolId(typeof record.exclusiveGroup === "string" ? record.exclusiveGroup : "");
    const description = typeof record.description === "string" ? record.description.trim() : "";
    return [{
      id,
      label,
      args,
      ...(record.defaultEnabled === true ? { defaultEnabled: true } : {}),
      ...(exclusiveGroup ? { exclusiveGroup } : {}),
      ...(description ? { description } : {}),
      ...(record.dangerous === true ? { dangerous: true } : {})
    }];
  });
}

export function parseTmuxTools(value: string | undefined = process.env.CLI_WEB_TOOLS): TmuxToolConfig[] {
  if (!value?.trim()) {
    return DEFAULT_TMUX_TOOLS;
  }

  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error("CLI_WEB_TOOLS must be a JSON array");
  }

  const tools = parsed.flatMap((entry, index) => {
    if (!entry || typeof entry !== "object") {
      return [];
    }
    const record = entry as Record<string, unknown>;
    const command = typeof record.command === "string" ? record.command.trim() : "";
    if (!command) {
      return [];
    }
    const label = typeof record.label === "string" && record.label.trim() ? record.label.trim() : `Tool ${index + 1}`;
    const id = normalizeTmuxToolId(typeof record.id === "string" ? record.id : label) || `tool-${index + 1}`;
    const defaultSessionName = normalizeTmuxSessionName(
      typeof record.defaultSessionName === "string" && record.defaultSessionName.trim()
        ? record.defaultSessionName
        : id
    );
    const modes = parseTmuxToolModes(record.modes);
    return [{ id, label, command, defaultSessionName, ...(modes.length > 0 ? { modes } : {}) }];
  });

  if (tools.length === 0) {
    throw new Error("CLI_WEB_TOOLS did not contain any usable tools");
  }

  return tools;
}

export function listTmuxTools(): TmuxToolConfig[] {
  return parseTmuxTools();
}

export function buildTmuxNewSessionArgs(name: string, cwd?: string | null): string[] {
  const args = [
    "new-session",
    "-d",
    "-x",
    String(DEFAULT_DETACHED_TMUX_COLS),
    "-y",
    String(DEFAULT_DETACHED_TMUX_ROWS),
    "-s",
    normalizeTmuxSessionName(name)
  ];
  if (cwd) {
    args.push("-c", cwd);
  }
  return args;
}

export function buildTmuxCreateSessionArgs(name: string, cwd: string | null | undefined, currentHistoryLimit: number | null): string[] {
  const newSessionArgs = buildTmuxNewSessionArgs(name, cwd);
  if (currentHistoryLimit !== null && currentHistoryLimit >= TMUX_CAPTURE_HISTORY_LINES) {
    return newSessionArgs;
  }
  return [
    ...(currentHistoryLimit === null ? ["start-server", ";"] : []),
    "set-option",
    "-g",
    "history-limit",
    String(TMUX_CAPTURE_HISTORY_LINES),
    ";",
    ...newSessionArgs
  ];
}

export function buildTmuxKillSessionArgs(session: string): string[] {
  return ["kill-session", "-t", session];
}

export function buildTmuxKillPaneArgs(paneTarget: string): string[] {
  return ["kill-pane", "-t", paneTarget];
}

// Only an exact pane target from the current listing can be closed; session names never match.
export function resolveClosableTmuxPane(entries: TmuxSession[], requested: unknown): TmuxSession {
  const entry = typeof requested === "string" ? entries.find((candidate) => candidate.name === requested && candidate.paneId) : undefined;
  if (!entry) {
    throw new TmuxRequestError(`Unknown tmux pane: ${JSON.stringify(requested ?? null).slice(0, 40)}`);
  }
  return entry;
}

// A listed pane on this host's tmux server; shim panes live in containers host tools can't reach.
export function resolveLocalTmuxPane(entries: TmuxSession[], requested: unknown): TmuxSession {
  const entry = resolveClosableTmuxPane(entries, requested);
  if (splitTmuxPaneTarget(entry.name)?.routingPrefix !== "") {
    throw new TmuxRequestError(`Unknown tmux pane: ${JSON.stringify(requested ?? null).slice(0, 40)}`);
  }
  return entry;
}

export async function closeTmuxPane(paneTarget: string): Promise<void> {
  await execFileAsync("tmux", buildTmuxKillPaneArgs(paneTarget));
}

export function buildTmuxPaneInModeArgs(session: string): string[] {
  return ["display-message", "-p", "-t", session, "#{pane_in_mode}"];
}

export function buildTmuxCancelModeArgs(session: string): string[] {
  return ["send-keys", "-t", session, "-X", "cancel"];
}

export function buildTmuxSubmitKeysArgs(session: string, submitKey: TmuxSubmitKey = "enter"): string[] {
  return ["send-keys", "-t", session, submitKey === "tab" ? "Tab" : "Enter"];
}

export function buildTmuxInterruptKeysArgs(session: string, interruptKey: TmuxInterruptKey): string[] {
  return ["send-keys", "-t", session, interruptKey === "escape" ? "Escape" : "C-c"];
}

// Named keys the key strip may send: Escape/Tab/Enter, arrows (optionally C-/M-), C-a..C-z, M-<printable ASCII>.
const ALLOWED_TMUX_KEY_PATTERN = /^(?:Escape|Tab|Enter|(?:[CM]-)?(?:Up|Down|Left|Right)|C-[a-z]|M-[\x21-\x7e])$/;

export class TmuxRequestError extends Error {
  readonly statusCode = 400;
}

export function isAllowedTmuxKey(key: unknown): key is string {
  return typeof key === "string" && ALLOWED_TMUX_KEY_PATTERN.test(key);
}

export function buildTmuxSendKeyArgs(session: string, key: string): string[] {
  if (!isAllowedTmuxKey(key)) {
    throw new TmuxRequestError(`Unsupported tmux key: ${JSON.stringify(key).slice(0, 40)}`);
  }
  // tmux treats a trailing ";" in an argument as a command separator unless it is escaped.
  return ["send-keys", "-t", session, key.endsWith(";") ? `${key.slice(0, -1)}\\;` : key];
}

export function detectTmuxSubmitKey(output: string): TmuxSubmitKey {
  return isCodexTmuxOutput(output) ? "codex-enter" : "enter";
}

export function detectTmuxInterruptKey(output: string): TmuxInterruptKey {
  return isCodexTmuxOutput(output) ? "escape" : "ctrl-c";
}

export function tmuxSubmitDelayMs(submitKey: TmuxSubmitKey, text: string): number {
  return text.length > 0 ? 350 : 0;
}

export function chunkTmuxLiteralText(text: string, maxChunkLength = TMUX_LITERAL_SEND_CHUNK_SIZE): string[] {
  if (maxChunkLength < 1) {
    throw new Error("maxChunkLength must be at least 1");
  }

  const chunks: string[] = [];
  let index = 0;
  while (index < text.length) {
    let end = Math.min(index + maxChunkLength, text.length);
    if (end < text.length && isHighSurrogate(text.charCodeAt(end - 1))) {
      end -= 1;
    }
    if (end <= index) {
      end = Math.min(index + maxChunkLength, text.length);
    }
    chunks.push(text.slice(index, end));
    index = end;
  }
  return chunks;
}

export function buildCodexTmuxCommand(_options: CodexTmuxCommandOptions): string {
  return "codex";
}

export function parseTmuxSessions(output: string): TmuxSession[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      const formatted = parseFormattedTmuxSession(line);
      if (formatted) {
        return [formatted];
      }

      const match = line.match(/^(.+):\s+(\d+)\s+windows?\s+\(created\s+(.+?)\)(?:\s+\(attached\))?$/);
      if (!match) {
        return [];
      }

      return [
        {
          name: match[1],
          windows: Number(match[2]),
          created: match[3],
          attached: line.includes("(attached)"),
          clientCount: line.includes("(attached)") ? 1 : 0
        }
      ];
    });
}

function parseFormattedTmuxSession(line: string): TmuxSession | null {
  const parts = line.split("\t");
  if (parts.length < 6) {
    return null;
  }
  const [name, windows, created, attached, activity, currentCommand, panePidValue, currentPath, ...paneTitleParts] = parts;
  const paneTitle = paneTitleParts.join("\t");
  const windowCount = Number(windows);
  const clientCount = Number(attached);
  const panePid = Number(panePidValue);
  const createdAtMs = unixSecondsToMs(created);
  const activityAtMs = unixSecondsToMs(activity);
  if (!name || !Number.isFinite(windowCount) || !Number.isFinite(clientCount) || !createdAtMs) {
    return null;
  }

  return {
    name,
    windows: windowCount,
    created: new Date(createdAtMs).toISOString(),
    createdAtMs,
    attached: clientCount > 0,
    clientCount: Math.max(0, clientCount),
    ...(Number.isInteger(panePid) && panePid > 0 ? { panePid } : {}),
    ...(currentPath ? { currentPath } : {}),
    ...(activityAtMs ? { activityAtMs } : {}),
    ...(currentCommand ? { currentCommand } : {}),
    ...(paneTitle ? { paneTitle } : {})
  };
}

function unixSecondsToMs(value: string): number | undefined {
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined;
}

export async function createTmuxSession(name: string, cwd?: string | null): Promise<TmuxSession[]> {
  const currentHistoryLimit = await readTmuxHistoryLimit();
  await execFileAsync("tmux", buildTmuxCreateSessionArgs(name, cwd, currentHistoryLimit));
  return listTmuxSessions();
}

export async function destroyTmuxSession(session: string): Promise<TmuxSession[]> {
  await execFileAsync("tmux", buildTmuxKillSessionArgs(session));
  return listTmuxSessions();
}

export const TMUX_LIST_PANES_FORMAT = [
  "#{session_name}",
  "#{pane_id}",
  "#{window_id}",
  "#{window_index}",
  "#{pane_index}",
  "#{window_active}",
  "#{pane_active}",
  "#{session_windows}",
  "#{session_created}",
  "#{session_attached}",
  "#{window_activity}",
  "#{pane_current_command}",
  "#{pane_pid}",
  "#{pane_current_path}",
  "#{window_panes}",
  "#{host}",
  // tmux-hide-window's window marks: home session id and snooze deadline (unix seconds).
  "#{@hide_origin}",
  "#{@hide_until}",
  // tmux rejects tabs in window names; pane_title stays last so tabs in it are rejoined.
  "#{window_name}",
  "#{pane_title}"
].join("\t");

// tmux-hide-window parks hidden and snoozed windows in this detached session.
export const HIDDEN_TMUX_SESSION = "_hidden";

// A parked window with a wake deadline is snoozed; one peeked back into its home session is not.
export function parseTmuxWindowSnooze(session: string, hideOrigin: string, hideUntil: string): number | undefined {
  const untilMs = /^\d+$/.test(hideUntil) ? unixSecondsToMs(hideUntil) : undefined;
  return session === HIDDEN_TMUX_SESSION && hideOrigin && untilMs ? untilMs : undefined;
}

export function buildTmuxListPanesArgs(): string[] {
  return ["list-panes", "-a", "-F", TMUX_LIST_PANES_FORMAT];
}

export function parseTmuxPanes(output: string, homeDir: string | undefined = process.env.HOME): TmuxSession[] {
  const seen = new Set<string>();
  return output
    .split(/\r?\n/)
    .flatMap((line) => {
      const pane = parseTmuxPaneLine(line, homeDir);
      // Grouped sessions list the same panes again; keep the first owner and skip atw's own raw sessions.
      if (!pane || isTmuxRawSessionName(pane.session ?? "") || seen.has(pane.name)) {
        return [];
      }
      seen.add(pane.name);
      return [pane];
    })
    .sort((left, right) => compareStrings(left.session ?? "", right.session ?? "")
      || (left.windowIndex ?? 0) - (right.windowIndex ?? 0)
      || (left.paneIndex ?? 0) - (right.paneIndex ?? 0));
}

function parseTmuxPaneLine(line: string, homeDir: string | undefined): TmuxSession | null {
  const parts = line.split("\t");
  if (parts.length < 19) {
    return null;
  }
  const [
    session,
    paneTarget,
    windowId,
    windowIndexValue,
    paneIndexValue,
    windowActive,
    paneActive,
    windows,
    created,
    attached,
    activity,
    currentCommand,
    panePidValue,
    currentPath,
    windowPanesValue,
    host,
    hideOrigin,
    hideUntil,
    windowName,
    ...paneTitleParts
  ] = parts;
  const paneTitle = paneTitleParts.join("\t");
  const windowIndex = Number(windowIndexValue);
  const paneIndex = Number(paneIndexValue);
  const windowCount = Number(windows);
  const clientCount = Number(attached);
  const panePid = Number(panePidValue);
  const createdAtMs = unixSecondsToMs(created);
  const activityAtMs = unixSecondsToMs(activity);
  const target = splitTmuxPaneTarget(paneTarget);
  const snoozedUntilMs = parseTmuxWindowSnooze(session, hideOrigin, hideUntil);
  if (!session
    || !target
    || !Number.isInteger(windowIndex)
    || !Number.isInteger(paneIndex)
    || !Number.isFinite(windowCount)
    || !Number.isFinite(clientCount)
    || !createdAtMs) {
    return null;
  }

  return {
    name: paneTarget,
    session,
    paneId: target.paneId,
    ...(windowId ? { windowId } : {}),
    windowIndex,
    paneIndex,
    windowActive: windowActive === "1",
    paneActive: paneActive === "1",
    label: buildTmuxPaneLabel({ session, windowIndex, paneIndex, currentCommand, currentPath }, homeDir),
    ...(windowName ? { windowName } : {}),
    displayName: buildTmuxPaneDisplayName({
      windowName,
      paneTitle,
      paneIndex,
      windowPanes: Number(windowPanesValue),
      host,
      fallback: `${session}:${windowIndex}.${paneIndex}`
    }),
    windows: windowCount,
    created: new Date(createdAtMs).toISOString(),
    createdAtMs,
    attached: clientCount > 0,
    clientCount: Math.max(0, clientCount),
    ...(Number.isInteger(panePid) && panePid > 0 ? { panePid } : {}),
    ...(currentPath ? { currentPath } : {}),
    ...(activityAtMs ? { activityAtMs } : {}),
    ...(currentCommand ? { currentCommand } : {}),
    ...(paneTitle ? { paneTitle } : {}),
    ...(snoozedUntilMs ? { snoozedUntilMs } : {})
  };
}

export function buildTmuxPaneLabel(
  pane: { session: string; windowIndex: number; paneIndex: number; currentCommand?: string; currentPath?: string },
  homeDir: string | undefined = process.env.HOME
): string {
  const command = displayTmuxPaneCommand(pane.currentCommand);
  const shortPath = shortenTmuxPanePath(pane.currentPath, homeDir);
  return [`${pane.session}:${pane.windowIndex}.${pane.paneIndex}`, command, shortPath].filter(Boolean).join(" \u00b7 ");
}

// The detected agent names the pane instead of its foreground process (e.g. "node" for codex).
export function buildTmuxPaneAgentLabel(pane: TmuxSession, agent: string, homeDir: string | undefined = process.env.HOME): string | undefined {
  if (pane.session === undefined || pane.windowIndex === undefined || pane.paneIndex === undefined) {
    return pane.label;
  }
  return buildTmuxPaneLabel({
    session: pane.session,
    windowIndex: pane.windowIndex,
    paneIndex: pane.paneIndex,
    currentCommand: agent,
    currentPath: pane.currentPath
  }, homeDir);
}

// Agents set live titles on the pane; the window name is the fallback, numbered when the window is split.
export function buildTmuxPaneDisplayName(pane: {
  windowName?: string;
  paneTitle?: string;
  paneIndex: number;
  windowPanes: number;
  host?: string;
  fallback: string;
}): string {
  const paneTitle = pane.paneTitle?.trim() ?? "";
  const hostNames = new Set([pane.host, pane.host?.split(".")[0]].filter(Boolean));
  // tmux defaults pane titles to the hostname, which says nothing about the pane.
  if (paneTitle && !hostNames.has(paneTitle)) {
    return paneTitle;
  }
  const windowName = pane.windowName?.trim() ?? "";
  if (!windowName) {
    return pane.fallback;
  }
  return pane.windowPanes > 1 ? `${windowName} \u00b7 pane ${pane.paneIndex}` : windowName;
}


export function shortenTmuxPanePath(currentPath: string | undefined, homeDir: string | undefined = process.env.HOME): string {
  if (!currentPath) {
    return "";
  }
  const home = homeDir?.replace(/\/+$/, "");
  const relative = home && (currentPath === home || currentPath.startsWith(`${home}/`))
    ? `~${currentPath.slice(home.length)}`
    : currentPath;
  const root = relative.startsWith("~") ? "~" : "";
  const segments = relative.slice(root.length).split("/").filter(Boolean);
  if (segments.length <= 3) {
    return relative;
  }
  return `${root ? "~/" : "/"}\u2026/${segments.slice(-2).join("/")}`;
}

// Pane ids are %N; anything before them is a routing prefix added by a tmux shim (e.g. "dk--box--").
export function splitTmuxPaneTarget(target: string): { routingPrefix: string; paneId: string } | null {
  const match = target.match(/^(.*?)(%\d+)$/);
  return match ? { routingPrefix: match[1], paneId: match[2] } : null;
}

// Accepts a pane target or, for older links and pins, a session name (resolved to its active pane).
export function resolveTmuxPaneEntry(entries: TmuxSession[], requested: string): TmuxSession | null {
  const exact = entries.find((entry) => entry.name === requested);
  if (exact) {
    return exact;
  }
  const inSession = entries.filter((entry) => entry.session === requested);
  return inSession.find((entry) => entry.windowActive && entry.paneActive) ?? inSession[0] ?? null;
}

export function resolveTmuxSessionName(entries: TmuxSession[], requested: string): string {
  return entries.find((entry) => entry.name === requested)?.session ?? requested;
}

export function buildTmuxViewerCountArgs(target: string): string[] {
  return [
    "display-message",
    "-p",
    "-t",
    target,
    "#{?session_grouped,#{session_group_attached},#{session_attached}} #{window_active_clients}"
  ];
}

export function parseTmuxViewerCounts(output: string): { sessionClients: number; windowClients: number } {
  const [sessionClients, windowClients] = output.trim().split(/\s+/).map((value) => Number(value));
  return {
    sessionClients: Number.isFinite(sessionClients) ? Math.max(0, sessionClients) : 0,
    windowClients: Number.isFinite(windowClients) ? Math.max(0, windowClients) : 0
  };
}

export async function readTmuxViewerCounts(target: string): Promise<{ sessionClients: number; windowClients: number }> {
  const { stdout } = await execFileAsync("tmux", buildTmuxViewerCountArgs(target));
  return parseTmuxViewerCounts(stdout);
}

export async function killTmuxSessionQuietly(target: string): Promise<void> {
  await execFileAsync("tmux", buildTmuxKillSessionArgs(target)).catch(() => undefined);
}

export async function listOrphanedTmuxRawSessions(): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync("tmux", ["list-sessions", "-F", "#{session_name}\t#{session_attached}"]);
    return stdout
      .split(/\r?\n/)
      .map((line) => line.split("\t"))
      .filter(([name, attached]) => name && isTmuxRawSessionName(name) && Number(attached) === 0)
      .map(([name]) => name);
  } catch {
    return [];
  }
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export async function listTmuxSessions(): Promise<TmuxSession[]> {
  try {
    const { stdout } = await execFileAsync("tmux", buildTmuxListPanesArgs());
    return parseTmuxPanes(stdout);
  } catch (error) {
    const stderr = error instanceof Error && "stderr" in error ? String(error.stderr) : "";
    if (stderr.includes("no server running")) {
      return [];
    }
    throw error;
  }
}

export async function openCodexInTmux(session: string, options: CodexTmuxCommandOptions): Promise<void> {
  await sendTmuxText(session, buildCodexTmuxCommand(options), true);
}

export async function openTmuxTool(session: string, tool: Pick<TmuxToolConfig, "command" | "modes">, modeIds?: string[]): Promise<void> {
  await sendTmuxText(session, buildTmuxToolCommand(tool, modeIds), true);
}

export function buildTmuxCapturePaneArgs(session: string, lines: number, joinWrappedLines = false, escapes = false): string[] {
  return [
    "capture-pane",
    "-p",
    ...(escapes ? ["-e"] : []),
    ...(joinWrappedLines ? ["-J"] : []),
    "-t",
    session,
    "-S",
    `-${lines}`
  ];
}

export async function captureTmuxPane(
  session: string,
  lines = TMUX_CAPTURE_HISTORY_LINES,
  joinWrappedLines = false,
  escapes = false
): Promise<string> {
  const safeLines = normalizeTmuxCaptureLines(lines);
  const { stdout } = await execFileAsync(
    "tmux",
    buildTmuxCapturePaneArgs(session, safeLines, joinWrappedLines, escapes),
    { maxBuffer: TMUX_CAPTURE_MAX_BUFFER_BYTES }
  );
  return escapes ? trimTmuxAnsiCapture(stdout) : trimTmuxCapture(stdout);
}

export async function captureTmuxVisiblePane(session: string): Promise<string> {
  const { stdout } = await execFileAsync("tmux", ["capture-pane", "-p", "-t", session], {
    maxBuffer: TMUX_CAPTURE_MAX_BUFFER_BYTES
  });
  return trimTmuxCapture(stdout);
}

type OpenCodeSessionStateRow = {
  sessionId?: unknown;
  messageId?: unknown;
  completedAt?: unknown;
  choicePending?: unknown;
};

type OpenCodeRootSession = {
  id: string;
  directory: string;
  title: string;
};

type OpenCodeTextRow = {
  messageId?: unknown;
  role?: unknown;
  text?: unknown;
};

export function parseOpenCodeSessionStates(serialized: string): Map<string, TmuxSessionStatusDto> {
  let rows: unknown;
  try {
    rows = JSON.parse(serialized);
  } catch {
    return new Map();
  }
  if (!Array.isArray(rows)) {
    return new Map();
  }
  const states = new Map<string, TmuxSessionStatusDto>();
  for (const value of rows) {
    if (!value || typeof value !== "object") {
      continue;
    }
    const row = value as OpenCodeSessionStateRow;
    if (typeof row.sessionId !== "string" || !row.sessionId) {
      continue;
    }
    if (Number(row.choicePending) > 0) {
      states.set(row.sessionId, tmuxStatus("blocked", "Asking a question"));
      continue;
    }
    if (typeof row.messageId === "string" && row.messageId && row.completedAt == null) {
      states.set(row.sessionId, tmuxStatus("working"));
      continue;
    }
    states.set(row.sessionId, tmuxStatus("idle"));
  }
  return states;
}

export function extractOpenCodeSessionId(args: string[]): string | null {
  const sessionIndex = args.findIndex((arg) => arg === "-s" || arg === "--session");
  const sessionId = sessionIndex === -1 ? "" : args[sessionIndex + 1] ?? "";
  return /^ses_[A-Za-z0-9]+$/.test(sessionId) ? sessionId : null;
}

export function matchOpenCodePaneSession(
  sessions: OpenCodeRootSession[],
  directory: string | undefined,
  paneTitle: string | undefined
): string | null {
  if (!directory || !paneTitle?.startsWith("OC | ")) {
    return null;
  }
  const displayedTitle = paneTitle.slice("OC | ".length).trim();
  const truncated = displayedTitle.endsWith("...") || displayedTitle.endsWith("\u2026");
  const title = truncated
    ? displayedTitle.replace(/(?:\.\.\.|\u2026)$/u, "").trimEnd()
    : displayedTitle;
  if (!title) {
    return null;
  }
  const matches = sessions.filter((session) => session.directory === directory && (
    truncated ? session.title.startsWith(title) : session.title === title
  ));
  return matches.length === 1 ? matches[0].id : null;
}

export function renderOpenCodeTextStream(serialized: string): string | null {
  let rows: unknown;
  try {
    rows = JSON.parse(serialized);
  } catch {
    return null;
  }
  if (!Array.isArray(rows)) {
    return null;
  }

  const output: string[] = [];
  let currentRole = "";
  let currentMessageId = "";
  for (const value of rows) {
    if (!value || typeof value !== "object") {
      continue;
    }
    const row = value as OpenCodeTextRow;
    if ((row.role !== "user" && row.role !== "assistant") || typeof row.text !== "string" || !row.text.trim()) {
      continue;
    }
    const messageId = typeof row.messageId === "string" ? row.messageId : "";
    if (row.role !== currentRole) {
      if (output.length > 0 && output.at(-1) !== "") {
        output.push("");
      }
      output.push(row.role === "user" ? "You" : "Assistant", "");
      currentRole = row.role;
    } else if (messageId && messageId !== currentMessageId && output.at(-1) !== "") {
      output.push("");
    }
    output.push(row.text, "");
    currentMessageId = messageId;
  }
  while (output.at(-1) === "") {
    output.pop();
  }
  return output.length > 0 ? output.join("\n") : null;
}

export function buildOpenCodeSqliteArgs(databasePath: string, query: string, json = true): string[] {
  return ["-readonly", ...(json ? ["-json"] : []), databasePath, query];
}

export async function readTmuxHarnessStatuses(sessions: TmuxSession[]): Promise<Map<string, TmuxSessionStatusDto>> {
  const identified = [...(await identifyOpenCodeSessions(sessions)).entries()]
    .map(([name, sessionId]) => ({ name, sessionId }));
  if (identified.length === 0) {
    return new Map();
  }

  const sessionIds = [...new Set(identified.map(({ sessionId }) => sessionId))];
  const quotedIds = sessionIds.map((sessionId) => `'${sessionId}'`).join(",");
  const query = `
    SELECT
      s.id AS sessionId,
      m.id AS messageId,
      json_extract(m.data, '$.time.completed') AS completedAt,
      EXISTS(
        SELECT 1 FROM part p
        WHERE p.message_id = m.id
          AND json_extract(p.data, '$.type') = 'tool'
          AND json_extract(p.data, '$.tool') = 'question'
          AND json_extract(p.data, '$.state.status') = 'running'
      ) AS choicePending
    FROM session s
    LEFT JOIN message m ON m.id = (
      SELECT latest.id FROM message latest
      WHERE latest.session_id = s.id
        AND json_extract(latest.data, '$.role') = 'assistant'
      ORDER BY latest.time_created DESC, latest.id DESC
      LIMIT 1
    )
    WHERE s.id IN (${quotedIds})
  `;
  let stdout: string;
  try {
    ({ stdout } = await queryOpenCodeDatabase(query, 1024 * 1024));
  } catch {
    return new Map();
  }
  const statesBySessionId = parseOpenCodeSessionStates(stdout);
  return new Map(identified.flatMap(({ name, sessionId }) => {
    const status = statesBySessionId.get(sessionId);
    return status ? [[name, status] as const] : [];
  }));
}

async function identifyOpenCodeSessions(sessions: TmuxSession[]): Promise<Map<string, string>> {
  const now = Date.now();
  for (const [name, cached] of openCodePaneSessionCache) {
    if (cached.expiresAt <= now) {
      openCodePaneSessionCache.delete(name);
    }
  }
  const openCodeSessions = sessions.filter((session) => isOpenCodeCommand(session.currentCommand) && session.panePid);
  const identified = new Map<string, string>();
  const uncached = openCodeSessions.filter((session) => {
    const cached = openCodePaneSessionCache.get(session.name);
    if (cached
      && cached.expiresAt > now
      && cached.panePid === session.panePid
      && cached.currentPath === session.currentPath
      && cached.paneTitle === session.paneTitle) {
      identified.set(session.name, cached.sessionId);
      return false;
    }
    openCodePaneSessionCache.delete(session.name);
    return true;
  });
  const explicit = await Promise.all(uncached.map(async (session) => ({
    session,
    sessionId: await readExplicitOpenCodeSessionIdForPane(session).catch(() => null)
  })));
  for (const { session, sessionId } of explicit) {
    if (sessionId) {
      identified.set(session.name, sessionId);
      cacheOpenCodePaneSession(session, sessionId, now);
    }
  }
  const unresolved = explicit.filter(({ sessionId }) => !sessionId);
  if (unresolved.length === 0) {
    return identified;
  }

  const rootSessions = await readOpenCodeRootSessions().catch(() => []);
  for (const { session } of unresolved) {
    const sessionId = matchOpenCodePaneSession(rootSessions, session.currentPath, session.paneTitle);
    if (sessionId) {
      identified.set(session.name, sessionId);
      cacheOpenCodePaneSession(session, sessionId, now);
    }
  }
  return identified;
}

function cacheOpenCodePaneSession(session: TmuxSession, sessionId: string, now: number): void {
  if (!session.panePid) {
    return;
  }
  openCodePaneSessionCache.set(session.name, {
    currentPath: session.currentPath,
    expiresAt: now + OPENCODE_SESSION_CACHE_MS,
    panePid: session.panePid,
    paneTitle: session.paneTitle,
    sessionId
  });
}

async function readExplicitOpenCodeSessionIdForPane(session: Pick<TmuxSession, "currentCommand" | "panePid">): Promise<string | null> {
  if (!isOpenCodeCommand(session.currentCommand) || !session.panePid) {
    return null;
  }
  const childrenPath = `/proc/${session.panePid}/task/${session.panePid}/children`;
  const childPids = (await readFile(childrenPath, "utf8")).trim().split(/\s+/).filter(Boolean);
  for (const childPid of childPids) {
    const command = await readFile(`/proc/${childPid}/comm`, "utf8").catch(() => "");
    if (command.trim() !== "opencode") {
      continue;
    }
    const args = (await readFile(`/proc/${childPid}/cmdline`, "utf8"))
      .split("\0")
      .filter(Boolean);
    const sessionId = extractOpenCodeSessionId(args);
    if (sessionId) {
      return sessionId;
    }
  }
  return null;
}

async function readOpenCodeRootSessions(): Promise<OpenCodeRootSession[]> {
  const query = `
    SELECT id, directory, title
    FROM session
    WHERE parent_id IS NULL
      AND time_archived IS NULL
  `;
  const { stdout } = await queryOpenCodeDatabase(query, 4 * 1024 * 1024);
  let rows: unknown;
  try {
    rows = JSON.parse(stdout);
  } catch {
    return [];
  }
  if (!Array.isArray(rows)) {
    return [];
  }
  return rows.flatMap((value) => {
    if (!value || typeof value !== "object") {
      return [];
    }
    const row = value as Record<string, unknown>;
    return typeof row.id === "string" && typeof row.directory === "string" && typeof row.title === "string"
      ? [{ id: row.id, directory: row.directory, title: row.title }]
      : [];
  });
}

export async function readOpenCodeTextStream(
  sessionId: string,
  knownRevision?: string
): Promise<{ output: string | null; outputAppend: boolean; outputUnchanged: boolean; revision: string } | null> {
  if (!/^ses_[A-Za-z0-9]+$/.test(sessionId)) {
    return null;
  }
  const revisionQuery = `
    SELECT
      COALESCE(MAX(p.time_updated), 0) || ':' ||
      COUNT(*) || ':' ||
      COALESCE(SUM(p.time_updated), 0)
    FROM message m
    JOIN part p ON p.message_id = m.id
    WHERE m.session_id = '${sessionId}'
      AND json_extract(m.data, '$.role') IN ('user', 'assistant')
      AND json_extract(p.data, '$.type') = 'text'
      AND json_type(p.data, '$.text') = 'text'
      AND TRIM(json_extract(p.data, '$.text')) <> ''
  `;
  const { stdout: revisionOutput } = await queryOpenCodeDatabase(revisionQuery, 1024, false);
  const revision = revisionOutput.trim();
  if (!/^\d+:\d+:\d+$/.test(revision)) {
    return null;
  }
  if (knownRevision === revision) {
    return { output: null, outputAppend: false, outputUnchanged: true, revision };
  }
  const cached = getCachedOpenCodeText(sessionId);
  if (cached?.revision === revision) {
    return { output: cached.output, outputAppend: false, outputUnchanged: false, revision };
  }
  const query = `
    SELECT
      m.id AS messageId,
      json_extract(m.data, '$.role') AS role,
      json_extract(p.data, '$.text') AS text
    FROM message m
    JOIN part p ON p.message_id = m.id
    WHERE m.session_id = '${sessionId}'
      AND json_extract(p.data, '$.type') = 'text'
    ORDER BY m.time_created, m.id, p.time_created, p.id
  `;
  const { stdout } = await queryOpenCodeDatabase(query, TMUX_CAPTURE_MAX_BUFFER_BYTES);
  const output = renderOpenCodeTextStream(stdout);
  const appendOutput = Boolean(
    output
    && cached?.output
    && cached.revision === knownRevision
    && output.startsWith(cached.output)
  );
  setCachedOpenCodeText(sessionId, output, revision);
  return {
    output: appendOutput && cached?.output ? output?.slice(cached.output.length) ?? null : output,
    outputAppend: appendOutput,
    outputUnchanged: false,
    revision
  };
}

function getCachedOpenCodeText(sessionId: string): OpenCodeTextCacheEntry | undefined {
  const cached = openCodeTextCache.get(sessionId);
  if (cached) {
    openCodeTextCache.delete(sessionId);
    openCodeTextCache.set(sessionId, cached);
  }
  return cached;
}

function setCachedOpenCodeText(sessionId: string, output: string | null, revision: string): void {
  const existing = openCodeTextCache.get(sessionId);
  if (existing) {
    openCodeTextCacheBytes -= existing.sizeBytes;
    openCodeTextCache.delete(sessionId);
  }
  const sizeBytes = output ? Buffer.byteLength(output) : 0;
  if (sizeBytes > OPENCODE_TEXT_CACHE_MAX_BYTES) {
    return;
  }
  while (openCodeTextCache.size >= OPENCODE_TEXT_CACHE_LIMIT
    || openCodeTextCacheBytes + sizeBytes > OPENCODE_TEXT_CACHE_MAX_BYTES) {
    const oldestSessionId = openCodeTextCache.keys().next().value;
    if (!oldestSessionId) {
      break;
    }
    const oldest = openCodeTextCache.get(oldestSessionId);
    openCodeTextCache.delete(oldestSessionId);
    openCodeTextCacheBytes -= oldest?.sizeBytes ?? 0;
  }
  openCodeTextCache.set(sessionId, { output, revision, sizeBytes });
  openCodeTextCacheBytes += sizeBytes;
}

function openCodeDatabasePath(): string {
  return path.join(
    process.env.XDG_DATA_HOME ?? path.join(process.env.HOME ?? "", ".local", "share"),
    "opencode",
    "opencode.db"
  );
}

async function queryOpenCodeDatabase(query: string, maxBuffer: number, json = true) {
  return execFileAsync("sqlite3", buildOpenCodeSqliteArgs(openCodeDatabasePath(), query, json), { maxBuffer });
}

export async function captureTmuxPaneView(
  session: string,
  lines = TMUX_CAPTURE_HISTORY_LINES,
  knownOutputRevision?: string,
  options: { ansi?: boolean } = {}
): Promise<TmuxPaneCapture> {
  const metadata = await inspectTmuxPane(session).catch(() => null);
  const escapes = Boolean(options.ansi);
  const output = await captureTmuxPane(session, lines, Boolean(metadata && !metadata.alternateScreen), escapes);
  const view = metadata && isOpenCodeFullTuiPane(metadata)
    ? splitOpenCodeTuiCapture(output, metadata.width, metadata.height) ?? { output }
    : { output };
  if (!metadata || !isOpenCodeTuiPane(metadata)) {
    return view;
  }
  const identified = await identifyOpenCodeSessions([{
    name: session,
    windows: 1,
    created: "",
    attached: false,
    clientCount: 0,
    currentCommand: metadata.currentCommand,
    panePid: metadata.panePid,
    currentPath: metadata.currentPath,
    paneTitle: metadata.paneTitle
  }]).catch(() => new Map());
  const sessionId = identified.get(session);
  const persistedOutput = sessionId
    ? await readOpenCodeTextStream(sessionId, knownOutputRevision).catch(() => null)
    : null;
  if (persistedOutput?.outputUnchanged) {
    return {
      ...view,
      output: "",
      outputRevision: persistedOutput.revision,
      outputUnchanged: true
    };
  }
  if (persistedOutput?.outputAppend) {
    return {
      ...view,
      output: persistedOutput.output ?? "",
      outputAppend: true,
      outputRevision: persistedOutput.revision
    };
  }
  return persistedOutput?.output
    ? {
        ...view,
        output: persistedOutput.output,
        outputRevision: persistedOutput.revision
      }
    : view;
}

export function normalizeTmuxCaptureLines(lines: number): number {
  if (!Number.isFinite(lines)) {
    return TMUX_CAPTURE_HISTORY_LINES;
  }
  return Math.max(MIN_TMUX_CAPTURE_LINES, Math.min(Math.floor(lines), TMUX_CAPTURE_HISTORY_LINES));
}

async function readTmuxHistoryLimit(): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync("tmux", ["show-options", "-gv", "history-limit"]);
    const historyLimit = Number(stdout.trim());
    return Number.isInteger(historyLimit) && historyLimit > 0 ? historyLimit : null;
  } catch {
    return null;
  }
}

export async function inspectTmuxPane(session: string): Promise<TmuxPaneMetadata> {
  const { stdout } = await execFileAsync("tmux", [
    "display-message",
    "-p",
    "-t",
    session,
    "#{pane_current_command}\t#{pane_width}\t#{pane_height}\t#{alternate_on}\t#{pane_pid}\t#{pane_current_path}\t#{pane_title}"
  ]);
  return parseTmuxPaneMetadata(stdout);
}

export function parseTmuxPaneMetadata(output: string): TmuxPaneMetadata {
  const [currentCommand = "", widthValue = "", heightValue = "", alternateValue = "", panePidValue = "", currentPath = "", ...paneTitleParts] = output.trim().split("\t");
  const width = Number(widthValue);
  const height = Number(heightValue);
  const panePid = Number(panePidValue);
  const paneTitle = paneTitleParts.join("\t");
  if (!currentCommand || !Number.isInteger(width) || width < 1 || !Number.isInteger(height) || height < 1 || !/^[01]$/.test(alternateValue)) {
    throw new Error("Invalid tmux pane metadata");
  }
  return {
    currentCommand,
    width,
    height,
    alternateScreen: alternateValue === "1",
    ...(Number.isInteger(panePid) && panePid > 0 ? { panePid } : {}),
    ...(currentPath ? { currentPath } : {}),
    ...(paneTitle ? { paneTitle } : {})
  };
}

export function isOpenCodeFullTuiPane(metadata: TmuxPaneMetadata): boolean {
  return isOpenCodeTuiPane(metadata) && metadata.width > 120;
}

export function isOpenCodeTuiPane(metadata: TmuxPaneMetadata): boolean {
  return metadata.alternateScreen && isOpenCodeCommand(metadata.currentCommand);
}

function isOpenCodeCommand(currentCommand: string | undefined): boolean {
  return Boolean(currentCommand && /(?:^|[/\\])opencode(?:\.exe)?$/i.test(currentCommand));
}

export function splitOpenCodeTuiCapture(output: string, paneWidth: number, paneHeight?: number): TmuxPaneView | null {
  const sidebarWidth = 42;
  if (!Number.isInteger(paneWidth) || paneWidth <= 120 || paneWidth <= sidebarWidth) {
    return null;
  }

  const splitColumn = paneWidth - sidebarWidth;
  const mainLines: string[] = [];
  const sidebarLines: string[] = [];
  const lines = output.split(/\r?\n/);
  const visibleStart = paneHeight ? Math.max(0, lines.length - paneHeight) : 0;
  for (const [index, line] of lines.entries()) {
    if (index < visibleStart) {
      mainLines.push(line.trimEnd());
      continue;
    }
    const [main, sidebar] = splitDisplayLineAtColumn(line, splitColumn);
    mainLines.push(main.trimEnd());
    sidebarLines.push(sidebar.trimEnd());
  }

  const sidebar = trimBlankCaptureRows(sidebarLines.join("\n"));
  if (!/\bContext\b/u.test(sidebar) || !/\bOpenCode\s+\d/u.test(sidebar)) {
    return null;
  }

  return {
    output: trimTmuxAnsiCapture(mainLines.join("\n")),
    sidebar: {
      kind: "opencode",
      output: sidebar
    }
  };
}

const TMUX_ESCAPE_PATTERN = /\u001b\[[0-9;:?<=>]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/gu;

// Escape sequences take no columns. The sidebar is returned plain; escapes from its columns trail the
// main text so a renderer that carries colour state across lines stays in step with tmux.
export function splitDisplayLineAtColumn(line: string, splitColumn: number): [string, string] {
  if (line.includes("\u001b")) {
    let main = "";
    let sidebar = "";
    let trailing = "";
    let column = 0;
    let cursor = 0;
    const addText = (text: string) => {
      const [left, right] = splitDisplayLineAtColumn(text, splitColumn - column);
      main += left;
      sidebar += right;
      column += stringWidth(text);
    };
    for (const match of line.matchAll(TMUX_ESCAPE_PATTERN)) {
      addText(line.slice(cursor, match.index));
      cursor = (match.index ?? 0) + match[0].length;
      if (column < splitColumn) {
        main += match[0];
      } else if (match[0].endsWith("m") && match[0].startsWith("\u001b[")) {
        trailing += match[0];
      }
    }
    addText(line.slice(cursor));
    return [main + trailing, sidebar];
  }
  if (splitColumn <= 0) {
    return ["", line];
  }

  let column = 0;
  let main = "";
  let sidebar = "";
  const segments = new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(line);
  for (const { segment } of segments) {
    const width = stringWidth(segment);
    if (column >= splitColumn) {
      sidebar += segment;
    } else {
      main += segment;
    }
    column += width;
  }
  return [main, sidebar];
}

export function trimBlankCaptureRows(output: string): string {
  return output
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/^(?:[\t ]*\n)+/u, "")
    .replace(/[\t\n ]+$/u, "");
}

export function trimTmuxCapture(output: string): string {
  return output.replace(/[\t\r\n ]+$/u, "");
}

// capture-pane -e can end blank rows with SGR resets; trim those along with the whitespace.
export function trimTmuxAnsiCapture(output: string): string {
  return output.replace(/(?:[\t\r\n ]|\u001b\[[0-9;:]*m)+$/u, "");
}

export async function sendTmuxText(session: string, text: string, enter: boolean, submitKey: TmuxSubmitKey = "enter"): Promise<void> {
  await exitTmuxModeIfNeeded(session);

  if (text.length > 0) {
    for (const chunk of chunkTmuxLiteralText(text)) {
      await execFileAsync("tmux", ["send-keys", "-t", session, "-l", chunk]);
    }
  }

  if (enter) {
    const delayMs = tmuxSubmitDelayMs(submitKey, text);
    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    await execFileAsync("tmux", buildTmuxSubmitKeysArgs(session, submitKey));
  }
}

export async function interruptTmuxPane(session: string, interruptKey: TmuxInterruptKey): Promise<void> {
  await exitTmuxModeIfNeeded(session);
  await execFileAsync("tmux", buildTmuxInterruptKeysArgs(session, interruptKey));
}

export async function sendTmuxKey(session: string, key: string): Promise<void> {
  const args = buildTmuxSendKeyArgs(session, key);
  await exitTmuxModeIfNeeded(session);
  await execFileAsync("tmux", args);
}

async function exitTmuxModeIfNeeded(session: string): Promise<void> {
  const { stdout } = await execFileAsync("tmux", buildTmuxPaneInModeArgs(session));
  if (stdout.trim() !== "1") {
    return;
  }

  try {
    await execFileAsync("tmux", buildTmuxCancelModeArgs(session));
  } catch (error) {
    const stderr = error instanceof Error && "stderr" in error ? String(error.stderr) : "";
    if (!stderr.includes("not in a mode") && !stderr.includes("not in mode")) {
      throw error;
    }
  }
}

function isHighSurrogate(value: number): boolean {
  return value >= 0xd800 && value <= 0xdbff;
}

function isCodexTmuxOutput(output: string): boolean {
  const normalized = output.toLowerCase();
  return normalized.includes("openai codex")
    || normalized.includes("use /skills to list available skills")
    || /gpt-[\w.-]+.*\/model to change/.test(normalized);
}
