import { Router, type NextFunction, type Request, type Response } from "express";

import type { TmuxRenameResultDto } from "../shared/api.js";
import { buildTmuxRenameText, sanitizeTmuxRenameName, supportsTmuxRename } from "../shared/tmuxRename.js";
import { resolveClosableTmuxPane, TmuxRequestError, type TmuxSession } from "./tmux.js";

export type TmuxRenameRouterOptions = {
  listPanes: () => Promise<TmuxSession[]>;
  readPaneAgents: (panes: TmuxSession[]) => Promise<Map<string, string>>;
  // Types the text literally, then submits it with a separate Enter.
  submitText: (target: string, text: string) => Promise<void>;
  onSubmitted?: (target: string) => void;
};

export function createTmuxRenameRouter({ listPanes, readPaneAgents, submitText, onSubmitted }: TmuxRenameRouterOptions): Router {
  const router = Router();

  router.post("/api/tmux/rename", handle(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const name = sanitizeTmuxRenameName(body.name);
    if (!name) {
      throw new TmuxRequestError("Enter a name for the session");
    }
    const pane = resolveClosableTmuxPane(await listPanes(), body.target);
    // The server's own agent detection decides, so a crafted request can't type into a shell.
    const agent = (await readPaneAgents([pane])).get(pane.name) ?? null;
    if (!agent || !supportsTmuxRename(agent)) {
      throw new TmuxRequestError(`Rename needs Claude, Codex or Pi in the pane, not ${agent ?? pane.currentCommand ?? "nothing"}`);
    }
    const text = buildTmuxRenameText(agent, name);
    await submitText(pane.name, text);
    onSubmitted?.(pane.name);
    res.json({ data: { target: pane.name, agent, name, text } satisfies TmuxRenameResultDto });
  }));

  return router;
}

function handle(handler: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    handler(req, res).catch(next);
  };
}
