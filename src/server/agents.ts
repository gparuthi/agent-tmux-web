import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, readdir, realpath, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import type { AgentDirectoryDto, AgentDto } from "../shared/api.js";

const execFileAsync = promisify(execFile);

export const NEW_AGENT_TMUX_SESSION = "main";
const MAX_AGENT_DIRECTORIES = 40;

export type AgentDefinition = AgentDto & {
  // Checked for existence before the agent is offered.
  binary: string;
  // Fixed text run by the login shell; never contains request data.
  shellCommand: string;
};

export function buildAgentDefinitions(homeDir: string = os.homedir()): AgentDefinition[] {
  const claude = path.join(homeDir, ".local/bin/claude");
  return [
    { id: "opencode", label: "OpenCode", binary: "/opt/homebrew/bin/opencode", shellCommand: "/opt/homebrew/bin/opencode" },
    { id: "pi", label: "pi", binary: "/opt/homebrew/bin/pi", shellCommand: "/opt/homebrew/bin/pi" },
    { id: "claude", label: "Claude Code", binary: claude, shellCommand: claude },
    // The owner's zsh `codex` function picks the personal CODEX_HOME, so call it by name.
    { id: "codex", label: "Codex", binary: "/opt/homebrew/bin/codex", shellCommand: "codex" }
  ];
}

export class AgentRequestError extends Error {
  readonly statusCode = 400;
}

export async function listAvailableAgents(definitions: AgentDefinition[] = buildAgentDefinitions()): Promise<AgentDefinition[]> {
  const available = await Promise.all(definitions.map(async (definition) => {
    try {
      await access(definition.binary, fsConstants.X_OK);
      return definition;
    } catch {
      return null;
    }
  }));
  return available.filter((definition): definition is AgentDefinition => definition !== null);
}

export function findAgentDefinition(agentId: unknown, definitions: AgentDefinition[]): AgentDefinition {
  const definition = typeof agentId === "string" ? definitions.find((entry) => entry.id === agentId) : undefined;
  if (!definition) {
    throw new AgentRequestError(`Unknown agent: ${typeof agentId === "string" ? agentId : String(agentId)}`);
  }
  return definition;
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

export function buildAgentWindowName(agentId: string, directory: string): string {
  const base = path.basename(directory).replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return `${agentId}:${base || "root"}`;
}

// Multiple arguments make tmux exec the shell directly instead of via `sh -c`.
export function buildAgentShellArgv(definition: AgentDefinition, shell: string): string[] {
  return [shell, "-lic", `${definition.shellCommand}; exec ${shell} -l`];
}

export function buildNewAgentTmuxArgs(options: {
  definition: AgentDefinition;
  directory: string;
  shell: string;
  sessionExists: boolean;
  session?: string;
}): string[] {
  const session = options.session ?? NEW_AGENT_TMUX_SESSION;
  const name = buildAgentWindowName(options.definition.id, options.directory);
  const command = buildAgentShellArgv(options.definition, options.shell);
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
  options: { definitions?: AgentDefinition[]; shell?: string; homeDir?: string } = {}
): Promise<{ pane: string; directory: string; windowName: string }> {
  const definition = findAgentDefinition(agentId, await listAvailableAgents(options.definitions));
  const directory = await resolveAgentDirectory(directoryInput, options.homeDir);
  const sessionExists = await execFileAsync("tmux", ["has-session", "-t", `=${NEW_AGENT_TMUX_SESSION}`])
    .then(() => true, () => false);
  const { stdout } = await execFileAsync("tmux", buildNewAgentTmuxArgs({
    definition,
    directory,
    shell: options.shell ?? resolveLoginShell(),
    sessionExists
  }));
  const pane = stdout.trim();
  if (!/^%\d+$/.test(pane)) {
    throw new Error(`tmux did not report the new pane id: ${pane}`);
  }
  return { pane, directory, windowName: buildAgentWindowName(definition.id, directory) };
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
