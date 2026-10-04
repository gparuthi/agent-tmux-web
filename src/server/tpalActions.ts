import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { Router, type NextFunction, type Request, type Response } from "express";

import type { TmuxActionDto, TmuxActionRunDto, TmuxActionsDto } from "../shared/api.js";
import { resolveLocalTmuxPane, TmuxRequestError, type TmuxSession } from "./tmux.js";

const execFileAsync = promisify(execFile);

// The autobuild wrapper may rebuild tpal on its first run after an edit.
const TPAL_LIST_TIMEOUT_MS = 120_000;
// Restart builtins wait for the agent to quit and resume.
const TPAL_RUN_TIMEOUT_MS = 180_000;
const TPAL_MAX_BUFFER = 4 * 1024 * 1024;

export class TpalError extends Error {
  constructor(message: string, readonly statusCode: number) {
    super(message);
  }
}

// ATW_TPAL_BIN overrides the owner's ~/.gp wrapper; set it empty to turn pane actions off.
export function resolveTpalBin(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.ATW_TPAL_BIN !== undefined) {
    return env.ATW_TPAL_BIN.trim() || null;
  }
  return env.HOME ? path.join(env.HOME, ".gp/tools/tpal/tpal") : null;
}

export async function findTpalBin(env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  const bin = resolveTpalBin(env);
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

export function buildTpalListArgs(pane: string): string[] {
  return ["list", "--json", "--pane", pane];
}

// "--" ends tpal's flags, so a name can't pass as one.
export function buildTpalRunArgs(pane: string, name: string, yes: boolean): string[] {
  return ["run", "--pane", pane, ...(yes ? ["--yes"] : []), "--", name];
}

// tpal's ranked entries, minus the ones that need a tmux client (prompts, popups, menus, key replays).
export function parseTpalListing(output: string): { header: string; actions: TmuxActionDto[] } {
  let value: unknown;
  try {
    value = JSON.parse(output);
  } catch {
    throw new TpalError("tpal list printed no JSON", 502);
  }
  const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
  if (!Array.isArray(record.entries)) {
    throw new TpalError("tpal list printed no entries", 502);
  }
  const actions: TmuxActionDto[] = [];
  for (const raw of record.entries) {
    const entry = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
    const kind = entry.kind;
    if (entry.needsClient !== false || (kind !== "run" && kind !== "builtin") || typeof entry.name !== "string" || !entry.name) {
      continue;
    }
    actions.push({
      name: entry.name,
      desc: typeof entry.desc === "string" ? entry.desc : "",
      kind,
      ...(typeof entry.group === "string" && entry.group ? { group: entry.group } : {}),
      ...(typeof entry.when === "string" && entry.when ? { when: entry.when } : {}),
      ...(entry.recent === true ? { recent: true } : {}),
      ...(typeof entry.confirm === "string" && entry.confirm ? { confirm: entry.confirm } : {})
    });
  }
  return { header: typeof record.header === "string" ? record.header : "", actions };
}

export type TpalActionsRouterOptions = {
  tpalBin: () => Promise<string | null>;
  listPanes: () => Promise<TmuxSession[]>;
};

export function createTpalActionsRouter({ tpalBin, listPanes }: TpalActionsRouterOptions): Router {
  const router = Router();

  async function runTpal(args: string[], timeout: number): Promise<string> {
    const bin = await tpalBin();
    if (!bin) {
      throw new TpalError("Pane actions are not available: tpal is not installed", 404);
    }
    try {
      const { stdout } = await execFileAsync(bin, args, { timeout, maxBuffer: TPAL_MAX_BUFFER });
      return stdout;
    } catch (error) {
      const stderr = error && typeof error === "object" && "stderr" in error ? String(error.stderr).trim() : "";
      const stdout = error && typeof error === "object" && "stdout" in error ? String(error.stdout).trim() : "";
      throw new TpalError([stdout, stderr].filter(Boolean).join("\n") || `tpal ${args[0]} failed`, 502);
    }
  }

  async function listActions(pane: string) {
    return parseTpalListing(await runTpal(buildTpalListArgs(pane), TPAL_LIST_TIMEOUT_MS));
  }

  router.get("/api/tmux/actions", handle(async (req, res) => {
    const pane = resolveLocalTmuxPane(await listPanes(), req.query.target);
    const { header, actions } = await listActions(pane.name);
    res.json({ data: { target: pane.name, header, actions } satisfies TmuxActionsDto });
  }));

  router.post("/api/tmux/actions/run", handle(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const pane = resolveLocalTmuxPane(await listPanes(), body.target);
    // Only a name tpal offers this pane right now, so stale or crafted names never reach `tpal run`.
    const action = typeof body.name === "string" ? (await listActions(pane.name)).actions.find((entry) => entry.name === body.name) : undefined;
    if (!action) {
      throw new TmuxRequestError(`Unknown action for this pane: ${JSON.stringify(body.name ?? null).slice(0, 60)}`);
    }
    if (action.confirm && body.yes !== true) {
      throw new TmuxRequestError(`${action.name}: ${action.confirm} Confirm to run it.`);
    }
    const output = await runTpal(buildTpalRunArgs(pane.name, action.name, Boolean(action.confirm)), TPAL_RUN_TIMEOUT_MS);
    res.json({ data: { output: output.trim() } satisfies TmuxActionRunDto });
  }));

  return router;
}

function handle(handler: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    handler(req, res).catch(next);
  };
}
