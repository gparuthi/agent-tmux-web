import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import express, { type NextFunction, type Request, type Response } from "express";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { TmuxSession } from "../tmux.js";
import {
  buildHideWindowRevealArgs,
  buildHideWindowSnoozeArgs,
  buildHideWindowWakeArgs,
  buildTmuxWindowPlacementArgs,
  createWindowSnoozeRouter,
  findHideWindowBin,
  parseTmuxWindowPlacement,
  resolveHideWindowBin,
  resolveSnoozablePane,
  type TmuxWindowPlacement
} from "../windowSnooze.js";

const pane = (name: string, session: string, paneId: string | undefined = name.match(/%\d+$/)?.[0]): TmuxSession => ({
  name,
  session,
  ...(paneId ? { paneId } : {}),
  windows: 2,
  created: "",
  attached: false,
  clientCount: 0
});

const PANES = [pane("%12", "main"), pane("%30", "_hidden"), pane("dk--box--%3", "dk--box--work"), pane("legacy", "legacy", undefined)];

describe("window snooze helpers", () => {
  it("resolves the hide-window wrapper from HOME, overridable and disabled by env", () => {
    expect(resolveHideWindowBin({ HOME: "/Users/me" })).toBe("/Users/me/.gp/tools/tmux-hide-window/tmux-hide-window");
    expect(resolveHideWindowBin({ HOME: "/Users/me", ATW_HIDE_WINDOW_BIN: "/opt/fake-hide" })).toBe("/opt/fake-hide");
    expect(resolveHideWindowBin({ HOME: "/Users/me", ATW_HIDE_WINDOW_BIN: "" })).toBeNull();
    expect(resolveHideWindowBin({})).toBeNull();
  });

  it("reports the wrapper only when it is executable", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "atw-hide-bin-"));
    try {
      const bin = path.join(dir, "hide");
      await writeFile(bin, "#!/bin/sh\n");
      expect(await findHideWindowBin({ ATW_HIDE_WINDOW_BIN: bin })).toBeNull();
      await chmod(bin, 0o755);
      expect(await findHideWindowBin({ ATW_HIDE_WINDOW_BIN: bin })).toBe(bin);
      expect(await findHideWindowBin({ ATW_HIDE_WINDOW_BIN: path.join(dir, "missing") })).toBeNull();
      expect(await findHideWindowBin({ ATW_HIDE_WINDOW_BIN: "" })).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("builds argv without a client flag or a shell", () => {
    expect(buildHideWindowSnoozeArgs("@7", "3h")).toEqual(["snooze", "@7", "3h"]);
    expect(buildHideWindowWakeArgs("@7")).toEqual(["wake-window", "@7"]);
    expect(buildHideWindowRevealArgs("@7")).toEqual(["reveal", "@7"]);
    expect(buildTmuxWindowPlacementArgs("%12")).toEqual(["display-message", "-p", "-t", "%12", "#{window_id}\t#{session_name}"]);
  });

  it("parses the pane's window id and session", () => {
    expect(parseTmuxWindowPlacement("@7\tmain\n")).toEqual({ windowId: "@7", session: "main" });
    expect(() => parseTmuxWindowPlacement("%7\tmain")).toThrow(/Unexpected tmux window/);
    expect(() => parseTmuxWindowPlacement("@7")).toThrow(/Unexpected tmux window/);
  });

  it("snoozes only exact, local panes from the listing", () => {
    expect(resolveSnoozablePane(PANES, "%12").name).toBe("%12");
    for (const requested of ["dk--box--%3", "legacy", "main", "%99", "%12 ", "", 12, null, undefined]) {
      expect(() => resolveSnoozablePane(PANES, requested), String(requested)).toThrow(/Unknown tmux pane/);
    }
  });
});

describe("window snooze endpoints", () => {
  let dir = "";
  let argvFile = "";
  let bin: string | null = null;
  let server: http.Server;
  let baseUrl = "";
  let placements: Map<string, TmuxWindowPlacement>;
  // What the fake tool's run does to tmux: the window's session afterwards.
  let sessionAfterRun: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "atw-snooze-"));
    argvFile = path.join(dir, "argv");
    bin = path.join(dir, "tmux-hide-window");
    // Records argv one per line; a "fail" file next to it makes it exit 1 like the real tool, an "old"
    // file makes it reject wake-window with its usage line and exit 2 like builds before that verb.
    await writeFile(bin, `#!/bin/sh\nif [ -f '${dir}/old' ] && [ "$1" = wake-window ]; then echo 'usage: tmux-hide-window [-c client] hide|toggle|reveal|snooze' >&2; exit 2; fi\nprintf '%s\\n' "$@" > '${argvFile}'\nif [ -f '${dir}/fail' ]; then echo 'hide-window: boom' >&2; exit 1; fi\n`);
    await chmod(bin, 0o755);
    placements = new Map([["%12", { windowId: "@7", session: "main" }], ["%30", { windowId: "@9", session: "_hidden" }]]);
    sessionAfterRun = "_hidden";

    const app = express();
    app.use(express.json());
    app.use(createWindowSnoozeRouter({
      hideWindowBin: async () => bin,
      listPanes: async () => PANES,
      listSessions: async () => [{ name: "%12", windows: 2, created: "", attached: false }],
      readWindowPlacement: async (target) => {
        const placement = placements.get(target) ?? [...placements.values()].find((entry) => entry.windowId === target);
        if (!placement) {
          throw new Error(`no placement for ${target}`);
        }
        let ran = false;
        try {
          await readFile(argvFile, "utf8");
          ran = true;
        } catch {
          ran = false;
        }
        return target.startsWith("@") && ran ? { ...placement, session: sessionAfterRun } : placement;
      }
    }));
    app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
      const record = error as { statusCode?: number; message?: string };
      res.status(record.statusCode ?? 500).json({ error: record.message });
    });
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });

  async function post(url: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
    const response = await fetch(`${baseUrl}${url}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    return { status: response.status, json: await response.json() as Record<string, unknown> };
  }

  async function ranArgv(): Promise<string[] | null> {
    try {
      return (await readFile(argvFile, "utf8")).trimEnd().split("\n");
    } catch {
      return null;
    }
  }

  it("snoozes the pane's window with argv [snooze, @N, duration] and returns the listing", async () => {
    const result = await post("/api/tmux/snooze", { target: "%12", duration: "3h" });
    expect(result.status).toBe(200);
    expect(result.json.data).toEqual([{ name: "%12", windows: 2, created: "", attached: false }]);
    expect(await ranArgv()).toEqual(["snooze", "@7", "3h"]);
  });

  it("rejects bad durations and unknown or remote targets with 400 before running the tool", async () => {
    for (const duration of ["", "3", "3x", "0h", "12345m", "3h; rm -rf ~", "$(id)", 3, null]) {
      const result = await post("/api/tmux/snooze", { target: "%12", duration });
      expect(result.status, String(duration)).toBe(400);
      expect(String(result.json.error)).toMatch(/Bad snooze duration/);
    }
    for (const target of ["%99", "main", "legacy", "dk--box--%3", "@7", null]) {
      const result = await post("/api/tmux/snooze", { target, duration: "1d" });
      expect(result.status, String(target)).toBe(400);
      expect(String(result.json.error)).toMatch(/Unknown tmux pane/);
    }
    expect((await post("/api/tmux/wake-window", { target: "%99" })).status).toBe(400);
    expect(await ranArgv()).toBeNull();
  });

  it("reports a refusal the tool only prints, e.g. a session's last window", async () => {
    sessionAfterRun = "main";
    const result = await post("/api/tmux/snooze", { target: "%12", duration: "1w" });
    expect(result.status).toBe(409);
    expect(String(result.json.error)).toMatch(/last window/);
  });

  it("surfaces the tool's failure", async () => {
    await writeFile(path.join(dir, "fail"), "");
    const result = await post("/api/tmux/snooze", { target: "%12", duration: "30m" });
    expect(result.status).toBe(502);
    expect(String(result.json.error)).toContain("hide-window: boom");
  });

  it("wakes just the snoozed window with argv [wake-window, @N]", async () => {
    sessionAfterRun = "main";
    const result = await post("/api/tmux/wake-window", { target: "%30" });
    expect(result.status).toBe(200);
    expect(await ranArgv()).toEqual(["wake-window", "@9"]);
  });

  it("falls back to reveal on a tmux-hide-window that predates wake-window", async () => {
    sessionAfterRun = "main";
    await writeFile(path.join(dir, "old"), "");
    const result = await post("/api/tmux/wake-window", { target: "%30" });
    expect(result.status).toBe(200);
    expect(await ranArgv()).toEqual(["reveal", "@9"]);
  });

  it("does not retry a wake-window that failed for another reason", async () => {
    await writeFile(path.join(dir, "fail"), "");
    const result = await post("/api/tmux/wake-window", { target: "%30" });
    expect(result.status).toBe(502);
    expect(await ranArgv()).toEqual(["wake-window", "@9"]);
  });

  it("refuses to wake a window that is not parked", async () => {
    const result = await post("/api/tmux/wake-window", { target: "%12" });
    expect(result.status).toBe(400);
    expect(String(result.json.error)).toMatch(/not snoozed/);
    expect(await ranArgv()).toBeNull();
  });

  it("answers 404 when tmux-hide-window is not installed", async () => {
    bin = null;
    expect((await post("/api/tmux/snooze", { target: "%12", duration: "1h" })).status).toBe(404);
    expect((await post("/api/tmux/wake-window", { target: "%30" })).status).toBe(404);
  });
});
