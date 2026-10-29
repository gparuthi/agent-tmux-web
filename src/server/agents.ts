import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, readdir, realpath, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import type { AgentDirectoryDto, AgentDto } from "../shared/api.js";
import { sanitizeTmuxRenameName, supportsTmuxRename } from "../shared/tmuxRename.js";

const execFileAsync = promisify(execFile);

export const NEW_AGENT_TMUX_SESSION = "main";
const MAX_AGENT_DIRECTORIES = 40;

export type AgentDefinition = AgentDto & {
  command: string;
  // Executables checked in order; the first one present is the agent's binary.
  candidates: string[];
  // Run by name so the login shell can apply the owner's wrapper function.
  byName?: boolean;
};

export type AvailableAgent = AgentDto & {
  binary: string;
  // Fixed text run by the login shell; request data only enters through buildAgentShellArgv's quoted name.
  shellCommand: string;
};

const AGENT_COMMANDS: Array<Omit<AgentDefinition, "candidates">> = [
  { id: "claude", label: "Claude Code", command: "claude" },
  { id: "hax", label: "hax", command: "hax" },
  { id: "opencode", label: "OpenCode", command: "opencode" },
  { id: "pi", label: "pi", command: "pi" },
  // The owner's zsh `codex` function picks the personal CODEX_HOME, so call it by name.
  { id: "codex", label: "Codex", command: "codex", byName: true }
];

// Common install dirs first, then the server's PATH (run.sh adds /opt/homebrew/bin under launchd).
export function agentBinaryDirs(homeDir: string = os.homedir(), envPath: string | undefined = process.env.PATH): string[] {
  const dirs = [
    path.join(homeDir, ".local/bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    ...(envPath ?? "").split(path.delimiter)
  ];
  return [...new Set(dirs.filter((dir) => path.isAbsolute(dir)))];
}

export function buildAgentDefinitions(homeDir: string = os.homedir(), dirs: string[] = agentBinaryDirs(homeDir)): AgentDefinition[] {
  return AGENT_COMMANDS.map((agent) => ({ ...agent, candidates: dirs.map((dir) => path.join(dir, agent.command)) }));
}

export class AgentRequestError extends Error {
  readonly statusCode = 400;
}

async function firstExecutable(candidates: string[]): Promise<string | null> {
  for (const candidate of candidates) {
    try {
      await access(candidate, fsConstants.X_OK);
      if ((await stat(candidate)).isFile()) {
        return candidate;
      }
    } catch {
      // Try the next install location.
    }
  }
  return null;
}

export function shellQuote(value: string): string {
  return /^[A-Za-z0-9_./-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`;
}

export async function listAvailableAgents(definitions: AgentDefinition[] = buildAgentDefinitions()): Promise<AvailableAgent[]> {
  const available = await Promise.all(definitions.map(async ({ id, label, command, candidates, byName }) => {
    const binary = await firstExecutable(candidates);
    return binary ? { id, label, binary, shellCommand: byName ? command : shellQuote(binary) } : null;
  }));
  return available.filter((agent): agent is AvailableAgent => agent !== null);
}

export function findAgentDefinition(agentId: unknown, agents: AvailableAgent[]): AvailableAgent {
  const agent = typeof agentId === "string" ? agents.find((entry) => entry.id === agentId) : undefined;
  if (!agent) {
    throw new AgentRequestError(`Unknown agent: ${typeof agentId === "string" ? agentId : String(agentId)}`);
  }
  return agent;
}

export async function resolveAgentDirectory(input: unknown, homeDir: string = os.homedir()): Promise<string> {
  const raw = typeof input === "string" ? input.trim() : "";
  if (!raw) {
    throw new AgentRequestError("Missing directory");
  }
  const expanded = raw === "~" ? homeDir : raw.startsWith("~/") ? path.join(homeDir, raw.slice(2)) : raw;
  if (!path.isAbsolute(expanded)) {
    throw new AgentRequestError(`Directory must be absolute or start with ~/: ${raw}`);
  }
  let resolved: string;
  try {
    resolved = await realpath(expanded);
  } catch {
    throw new AgentRequestError(`Directory does not exist: ${raw}`);
  }
  if (!(await stat(resolved)).isDirectory()) {
    throw new AgentRequestError(`Not a directory: ${raw}`);
  }
  return resolved;
}

// Agents whose CLI takes the session name at launch; the rest are renamed once they are running.
export const AGENT_LAUNCH_NAME_FLAGS: Readonly<Record<string, string>> = {
  claude: "--name",
  pi: "--name"
};

// One printable line; leading dashes go so the name can't read as another flag.
export function sanitizeNewAgentName(value: unknown): string {
  return sanitizeTmuxRenameName(value).replace(/^[-\s]+/u, "");
}

// Agents that only take a name through their rename command, typed once the TUI is up.
export function agentRenamesAfterLaunch(agentId: string, name: string): boolean {
  return name !== "" && supportsTmuxRename(agentId) && !Object.hasOwn(AGENT_LAUNCH_NAME_FLAGS, agentId);
}

// tmux expands #(...) and #{...} in -n, so a window name keeps only plain characters.
function windowSafeName(name: string): string {
  return name.replace(/[^\p{L}\p{N} ._-]+/gu, "-").replace(/^[-\s]+|[-\s]+$/gu, "").slice(0, 40).trim();
}

export function buildAgentWindowName(agentId: string, directory: string, name = ""): string {
  const named = windowSafeName(name);
  if (named) {
    return named;
  }
  const base = path.basename(directory).replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return `${agentId}:${base || "root"}`;
}

// Multiple arguments make tmux exec the shell directly instead of via `sh -c`.
// The script cds itself: tmux ignores `-c` when the server's own cwd was deleted (seen with tmux 3.8 on macOS).
export function buildAgentShellArgv(definition: AvailableAgent, shell: string, directory: string, name = ""): string[] {
  const flag = Object.hasOwn(AGENT_LAUNCH_NAME_FLAGS, definition.id) ? AGENT_LAUNCH_NAME_FLAGS[definition.id] : "";
  const safeName = sanitizeNewAgentName(name);
  const launch = flag && safeName ? `${definition.shellCommand} ${flag} ${shellQuote(safeName)}` : definition.shellCommand;
  return [shell, "-lic", `cd ${shellQuote(directory)} && ${launch}; exec ${shell} -l`];
}

export function buildNewAgentTmuxArgs(options: {
  definition: AvailableAgent;
  directory: string;
  shell: string;
  sessionExists: boolean;
  session?: string;
  // Sanitized session name; empty keeps the default window name and plain launch.
  name?: string;
}): string[] {
  const session = options.session ?? NEW_AGENT_TMUX_SESSION;
  const name = buildAgentWindowName(options.definition.id, options.directory, options.name);
  const command = buildAgentShellArgv(options.definition, options.shell, options.directory, options.name);
  const placement = options.sessionExists
    ? ["new-window", "-t", `=${session}:`]
    : ["new-session", "-d", "-s", session];
  return [...placement, "-P", "-F", "#{pane_id}", "-c", options.directory, "-n", name, ...command];
}

export function resolveLoginShell(): string {
  try {
    const shell = os.userInfo().shell;
    if (shell && path.isAbsolute(shell)) {
      return shell;
    }
  } catch {
    // Fall through to the macOS default.
  }
  return "/bin/zsh";
}

export async function startAgentInTmux(
  agentId: unknown,
  directoryInput: unknown,
  options: { definitions?: AgentDefinition[]; shell?: string; homeDir?: string; name?: unknown } = {}
): Promise<{ pane: string; directory: string; windowName: string }> {
  const definition = findAgentDefinition(agentId, await listAvailableAgents(options.definitions));
  const directory = await resolveAgentDirectory(directoryInput, options.homeDir);
  const name = sanitizeNewAgentName(options.name);
  const sessionExists = await execFileAsync("tmux", ["has-session", "-t", `=${NEW_AGENT_TMUX_SESSION}`])
    .then(() => true, () => false);
  const { stdout } = await execFileAsync("tmux", buildNewAgentTmuxArgs({
    definition,
    directory,
    shell: options.shell ?? resolveLoginShell(),
    sessionExists,
    name
  }));
  const pane = stdout.trim();
  if (!/^%\d+$/.test(pane)) {
    throw new Error(`tmux did not report the new pane id: ${pane}`);
  }
  return { pane, directory, windowName: buildAgentWindowName(definition.id, directory, name) };
}

export function defaultAgentRepoRoots(homeDir: string = os.homedir()): string[] {
  return [path.join(homeDir, "work"), path.join(homeDir, ".gp"), path.join(homeDir, "Vaults/personal")];
}

type DirectoryCandidate = { path: string; source: AgentDirectoryDto["source"]; timestampMs: number };

async function gitActivityMs(directory: string): Promise<number | null> {
  const stamps = await Promise.all([".git", ".git/index", ".git/HEAD", ".git/logs/HEAD"].map(async (entry) => {
    try {
      return (await stat(path.join(directory, entry))).mtimeMs;
    } catch {
      return null;
    }
  }));
  const found = stamps.filter((value): value is number => value !== null);
  return found.length > 0 ? Math.max(...found) : null;
}

export async function findGitRepos(roots: string[]): Promise<DirectoryCandidate[]> {
  const candidates: DirectoryCandidate[] = [];
  for (const root of roots) {
    const rootStamp = await gitActivityMs(root);
    if (rootStamp !== null) {
      candidates.push({ path: root, source: "repo", timestampMs: rootStamp });
    }
    const children = await readdir(root, { withFileTypes: true }).catch(() => []);
    for (const child of children) {
      if (!child.isDirectory()) {
        continue;
      }
      const childPath = path.join(root, child.name);
      const stamp = await gitActivityMs(childPath);
      if (stamp !== null) {
        candidates.push({ path: childPath, source: "repo", timestampMs: stamp });
      }
    }
  }
  return candidates;
}

export function mergeAgentDirectories(
  candidates: DirectoryCandidate[],
  homeDir: string = os.homedir(),
  limit = MAX_AGENT_DIRECTORIES
): AgentDirectoryDto[] {
  const best = new Map<string, DirectoryCandidate>();
  for (const candidate of candidates) {
    // Home itself is where idle shells sit, not a project; it can still be typed.
    if (path.resolve(candidate.path) === path.resolve(homeDir)) {
      continue;
    }
    const existing = best.get(candidate.path);
    best.set(candidate.path, {
      path: candidate.path,
      // A live pane at a repo path is labelled as a pane.
      source: existing?.source === "pane" ? "pane" : candidate.source,
      timestampMs: Math.max(candidate.timestampMs, existing?.timestampMs ?? 0)
    });
  }
  return [...best.values()]
    .sort((left, right) => right.timestampMs - left.timestampMs || left.path.localeCompare(right.path))
    .slice(0, limit)
    .map((candidate) => ({
      path: candidate.path,
      label: shortenHomePath(candidate.path, homeDir),
      source: candidate.source
    }));
}

export function shortenHomePath(directory: string, homeDir: string): string {
  if (directory === homeDir) {
    return "~";
  }
  return directory.startsWith(`${homeDir}/`) ? `~/${directory.slice(homeDir.length + 1)}` : directory;
}

export async function listAgentDirectories(
  panes: Array<{ currentPath?: string; activityAtMs?: number }>,
  homeDir: string = os.homedir(),
  roots: string[] = defaultAgentRepoRoots(homeDir)
): Promise<AgentDirectoryDto[]> {
  const paneCandidates: DirectoryCandidate[] = panes.flatMap((pane) => pane.currentPath
    ? [{ path: pane.currentPath, source: "pane" as const, timestampMs: pane.activityAtMs ?? 0 }]
    : []);
  return mergeAgentDirectories([...paneCandidates, ...await findGitRepos(roots)], homeDir);
}
