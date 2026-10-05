import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { Router, type NextFunction, type Request, type Response } from "express";

import type { TmuxSessionDto } from "../shared/api.js";
import { isValidWindowSnoozeDuration } from "../shared/windowSnooze.js";
import { HIDDEN_TMUX_SESSION, resolveLocalTmuxPane, TmuxRequestError, type TmuxSession } from "./tmux.js";

const execFileAsync = promisify(execFile);

// The autobuild wrapper may rebuild the Go binary on its first run after an edit.
const HIDE_WINDOW_TIMEOUT_MS = 60_000;

export class WindowSnoozeError extends Error {
  constructor(message: string, readonly statusCode: number) {
    super(message);
  }
}

// ATW_HIDE_WINDOW_BIN overrides the owner's ~/.gp wrapper; set it empty to turn snoozing off.
export function resolveHideWindowBin(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.ATW_HIDE_WINDOW_BIN !== undefined) {
    return env.ATW_HIDE_WINDOW_BIN.trim() || null;
  }
  return env.HOME ? path.join(env.HOME, ".gp/tools/tmux-hide-window/tmux-hide-window") : null;
}

export async function findHideWindowBin(env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  const bin = resolveHideWindowBin(env);
  if (!bin) {
    return null;
  }
  try {
    await access(bin, fsConstants.X_OK);
    return bin;
  } catch {
    return null;
  }
}

// No -c: atw has no tmux client of its own, and the tool only uses one for status messages.
export function buildHideWindowSnoozeArgs(windowId: string, duration: string): string[] {
  return ["snooze", windowId, duration];
}

// Wakes just this window and clears its snooze marks; reveal would peek its whole home session.
export function buildHideWindowWakeArgs(windowId: string): string[] {
  return ["wake-window", windowId];
}

// Builds of tmux-hide-window before wake-window only know reveal.
export function buildHideWindowRevealArgs(windowId: string): string[] {
  return ["reveal", windowId];
}

// The tool exits 2 with its usage line for a verb it doesn't know.
function isUnknownVerbFailure(error: unknown): boolean {
  const record = error && typeof error === "object" ? error as { code?: unknown; stderr?: unknown } : {};
  return record.code === 2 && String(record.stderr ?? "").includes("usage:");
}

export type TmuxWindowPlacement = { windowId: string; session: string };

export function buildTmuxWindowPlacementArgs(target: string): string[] {
  return ["display-message", "-p", "-t", target, "#{window_id}\t#{session_name}"];
}

export function parseTmuxWindowPlacement(output: string): TmuxWindowPlacement {
  const [windowId = "", session = ""] = output.trim().split("\t");
  if (!/^@\d+$/.test(windowId) || !session) {
    throw new WindowSnoozeError(`Unexpected tmux window for pane: ${JSON.stringify(output).slice(0, 40)}`, 500);
  }
  return { windowId, session };
}

export async function readTmuxWindowPlacement(target: string): Promise<TmuxWindowPlacement> {
  const { stdout } = await execFileAsync("tmux", buildTmuxWindowPlacementArgs(target));
  return parseTmuxWindowPlacement(stdout);
}

// tmux-hide-window runs against this host's tmux server, so only local panes.
export function resolveSnoozablePane(entries: TmuxSession[], requested: unknown): TmuxSession {
  return resolveLocalTmuxPane(entries, requested);
}

export function requireWindowSnoozeDuration(value: unknown): string {
  if (!isValidWindowSnoozeDuration(value)) {
    throw new TmuxRequestError(`Bad snooze duration: ${JSON.stringify(value ?? null).slice(0, 20)} (use 30m, 3h, 1d, 2w)`);
  }
  return value;
}

export type WindowSnoozeRouterOptions = {
  hideWindowBin: () => Promise<string | null>;
  listPanes: () => Promise<TmuxSession[]>;
  listSessions: () => Promise<TmuxSessionDto[]>;
  readWindowPlacement?: (target: string) => Promise<TmuxWindowPlacement>;
};

export function createWindowSnoozeRouter({
  hideWindowBin,
  listPanes,
  listSessions,
  readWindowPlacement = readTmuxWindowPlacement
}: WindowSnoozeRouterOptions): Router {
  const router = Router();

  async function runHideWindow(args: string[], fallbackArgs?: string[]): Promise<void> {
    const bin = await hideWindowBin();
    if (!bin) {
      throw new WindowSnoozeError("Window snooze is not available: tmux-hide-window is not installed", 404);
    }
    try {
      await execFileAsync(bin, args, { timeout: HIDE_WINDOW_TIMEOUT_MS });
    } catch (error) {
      if (fallbackArgs && isUnknownVerbFailure(error)) {
        return runHideWindow(fallbackArgs);
      }
      const stderr = error && typeof error === "object" && "stderr" in error ? String(error.stderr).trim() : "";
      throw new WindowSnoozeError(`tmux-hide-window ${args[0]} failed${stderr ? `: ${stderr}` : ""}`, 502);
    }
  }

  router.post("/api/tmux/snooze", handle(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const duration = requireWindowSnoozeDuration(body.duration);
    const pane = resolveSnoozablePane(await listPanes(), body.target);
    const { windowId } = await readWindowPlacement(pane.name);
    await runHideWindow(buildHideWindowSnoozeArgs(windowId, duration));
    // The tool exits 0 when it refuses, e.g. for a session's last window.
    if ((await readWindowPlacement(windowId)).session !== HIDDEN_TMUX_SESSION) {
      throw new WindowSnoozeError("The window was not snoozed: a session's last window can't be hidden", 409);
    }
    res.json({ data: await listSessions() });
  }));

  router.post("/api/tmux/wake-window", handle(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const pane = resolveSnoozablePane(await listPanes(), body.target);
    const { windowId, session } = await readWindowPlacement(pane.name);
    if (session !== HIDDEN_TMUX_SESSION) {
      throw new TmuxRequestError("That window is not snoozed");
    }
    await runHideWindow(buildHideWindowWakeArgs(windowId), buildHideWindowRevealArgs(windowId));
    if ((await readWindowPlacement(windowId)).session === HIDDEN_TMUX_SESSION) {
      throw new WindowSnoozeError("The window stayed hidden: its home session is gone", 409);
    }
    res.json({ data: await listSessions() });
  }));

  return router;
}

function handle(handler: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    handler(req, res).catch(next);
  };
}
