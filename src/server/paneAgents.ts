import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { tmuxPaneAgent } from "../shared/tmuxAgents.js";

const execFileAsync = promisify(execFile);

export const PROCESS_TABLE_CACHE_MS = 2_000;
// Pane shell (0), a wrapper such as `zsh -ic`, a launcher script, then the agent.
export const MAX_PANE_AGENT_DEPTH = 4;
const PS_MAX_BUFFER_BYTES = 8 * 1024 * 1024;
const INTERPRETER_PATTERN = /^(?:node|bun|deno|python[\d.]*)$/;
const SCRIPT_EXTENSION_PATTERN = /\.(?:[cm]?js|ts|py)$/i;

export type ProcessEntry = { pid: number; ppid: number; args: string };

// One `ps` snapshot, indexed by pid and by parent pid.
export type ProcessTable = { byPid: Map<number, ProcessEntry>; children: Map<number, ProcessEntry[]> };

export type PaneAgentInput = { name: string; paneId?: string; panePid?: number; currentCommand?: string };

export function parseProcessTable(output: string): ProcessTable {
  const table: ProcessTable = { byPid: new Map(), children: new Map() };
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    if (!match) {
      continue;
    }
    const entry = { pid: Number(match[1]), ppid: Number(match[2]), args: match[3].trim() };
    table.byPid.set(entry.pid, entry);
    const siblings = table.children.get(entry.ppid) ?? [];
    siblings.push(entry);
    table.children.set(entry.ppid, siblings);
  }
  return table;
}

// ps joins argv with spaces, so paths containing spaces split early; agent installs have none.
export function processArgsAgent(args: string): string | null {
  const argv = args.split(/\s+/).filter(Boolean);
  const program = argv[0] ?? "";
  const direct = tmuxPaneAgent(program);
  if (direct) {
    return direct;
  }
  const interpreter = program.split("/").pop()?.toLowerCase() ?? "";
  if (!INTERPRETER_PATTERN.test(interpreter)) {
    return null;
  }
  // The script is the first non-flag argument, after `run` for bun and deno.
  const rest = argv.slice(1).filter((arg) => !arg.startsWith("-"));
  const script = (interpreter === "bun" || interpreter === "deno") && rest[0] === "run" ? rest[1] : rest[0];
  return script ? tmuxPaneAgent(script.replace(SCRIPT_EXTENSION_PATTERN, "")) : null;
}

// Breadth-first, so the agent nearest the pane shell wins over anything it spawned.
export function findProcessTreeAgent(table: ProcessTable, rootPid: number, maxDepth = MAX_PANE_AGENT_DEPTH): string | null {
  const root = table.byPid.get(rootPid);
  let level: ProcessEntry[] = root ? [root] : [];
  for (let depth = 0; depth <= maxDepth && level.length > 0; depth += 1) {
    for (const entry of level) {
      const agent = processArgsAgent(entry.args);
      if (agent) {
        return agent;
      }
    }
    level = level.flatMap((entry) => table.children.get(entry.pid) ?? []);
  }
  return null;
}

export async function readProcessTable(): Promise<ProcessTable> {
  const { stdout } = await execFileAsync("ps", ["-A", "-o", "pid=,ppid=,args="], { maxBuffer: PS_MAX_BUFFER_BYTES });
  return parseProcessTable(stdout);
}

let cachedProcessTable: { atMs: number; table: Promise<ProcessTable | null> } | null = null;

// One ps per listing, shared by listings within PROCESS_TABLE_CACHE_MS.
export function readCachedProcessTable(nowMs = Date.now(), read: () => Promise<ProcessTable> = readProcessTable): Promise<ProcessTable | null> {
  if (!cachedProcessTable || nowMs - cachedProcessTable.atMs >= PROCESS_TABLE_CACHE_MS) {
    cachedProcessTable = { atMs: nowMs, table: read().catch(() => null) };
  }
  return cachedProcessTable.table;
}

export function resetProcessTableCache(): void {
  cachedProcessTable = null;
}

// Local panes use the live process tree; shim panes (pids from another host) and a failed ps fall back to tmux's command.
export function detectTmuxPaneAgents(panes: PaneAgentInput[], table: ProcessTable | null): Map<string, string> {
  const agents = new Map<string, string>();
  for (const pane of panes) {
    const local = pane.name === pane.paneId;
    const agent = (local && table && pane.panePid ? findProcessTreeAgent(table, pane.panePid) : null)
      ?? tmuxPaneAgent(pane.currentCommand);
    if (agent) {
      agents.set(pane.name, agent);
    }
  }
  return agents;
}

export async function readTmuxPaneAgents(panes: PaneAgentInput[]): Promise<Map<string, string>> {
  const needsTable = panes.some((pane) => pane.name === pane.paneId && pane.panePid);
  return detectTmuxPaneAgents(panes, needsTable ? await readCachedProcessTable() : null);
}
