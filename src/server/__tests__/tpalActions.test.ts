import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import express, { type NextFunction, type Request, type Response } from "express";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { TmuxSession } from "../tmux.js";
import {
  buildTpalListArgs,
  buildTpalRunArgs,
  createTpalActionsRouter,
  findTpalBin,
  parseTpalListing,
  resolveTpalBin
} from "../tpalActions.js";

const pane = (name: string, paneId: string | undefined = name.match(/%\d+$/)?.[0]): TmuxSession => ({
  name,
  session: "main",
  ...(paneId ? { paneId } : {}),
  windows: 1,
  created: "",
  attached: false,
  clientCount: 0
});

const PANES = [pane("%12"), pane("dk--box--%3"), pane("legacy", undefined)];

// What `tpal list --json --pane %12` prints for a codex pane (trimmed).
const LISTING = {
  pane: "%12",
  header: "pane %12 · codex",
  harness: "codex",
  entries: [
    { id: "act:handoff session", name: "handoff session", desc: "hand this pane's session over", kind: "builtin", when: "agent", group: "this pane", recent: false, needsClient: false },
    { id: "act:restart codex: yolo mode", name: "restart codex: yolo mode", desc: "no approvals", kind: "builtin", when: "codex", group: "this pane", recent: false, needsClient: false, confirm: "restart codex with no approvals and no sandbox?" },
    { id: "act:snooze window", name: "snooze window", desc: "hide this window", kind: "run", group: "recently used", recent: true, needsClient: true },
    { id: "act:next layout", name: "next layout", desc: "cycle pane layouts", kind: "run", group: "recently used", recent: true, needsClient: false },
    { id: "key:prefix:w", name: "C-a w", desc: "choose-tree", kind: "key", group: "all", recent: false, needsClient: true }
  ]
};

describe("tpal action helpers", () => {
  it("resolves the tpal wrapper from HOME, overridable and disabled by env", () => {
    expect(resolveTpalBin({ HOME: "/Users/me" })).toBe("/Users/me/.gp/tools/tpal/tpal");
    expect(resolveTpalBin({ HOME: "/Users/me", ATW_TPAL_BIN: "/opt/tpal" })).toBe("/opt/tpal");
    expect(resolveTpalBin({ HOME: "/Users/me", ATW_TPAL_BIN: " " })).toBeNull();
  });

  it("builds argv with the name after --", () => {
    expect(buildTpalListArgs("%12")).toEqual(["list", "--json", "--pane", "%12"]);
    expect(buildTpalRunArgs("%12", "next layout", false)).toEqual(["run", "--pane", "%12", "--", "next layout"]);
    expect(buildTpalRunArgs("%12", "-x", true)).toEqual(["run", "--pane", "%12", "--yes", "--", "-x"]);
  });

  it("keeps tpal's order and drops entries that need a tmux client", () => {
    const { header, actions } = parseTpalListing(JSON.stringify(LISTING));
    expect(header).toBe("pane %12 · codex");
    expect(actions.map((action) => action.name)).toEqual(["handoff session", "restart codex: yolo mode", "next layout"]);
    expect(actions[1]).toEqual({
      name: "restart codex: yolo mode",
      desc: "no approvals",
      kind: "builtin",
      group: "this pane",
      when: "codex",
      confirm: "restart codex with no approvals and no sandbox?"
    });
    expect(actions[2]).toMatchObject({ kind: "run", recent: true, group: "recently used" });
    expect(() => parseTpalListing("tpal: unknown flag")).toThrow(/no JSON/);
    expect(() => parseTpalListing("{}")).toThrow(/no entries/);
  });
});

describe("tpal action endpoints", () => {
  let dir = "";
  let argvFile = "";
  let bin: string | null = null;
  let server: http.Server;
  let baseUrl = "";

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "atw-tpal-"));
    argvFile = path.join(dir, "argv");
    await writeFile(path.join(dir, "listing.json"), JSON.stringify(LISTING));
    bin = path.join(dir, "tpal");
    // list prints the fixture; run records its argv, and a "fail" file makes it fail like tpal.
    await writeFile(bin, [
      "#!/bin/sh",
      `if [ "$1" = list ]; then cat '${dir}/listing.json'; exit 0; fi`,
      `printf '%s\\n' "$@" > '${argvFile}'`,
      `if [ -f '${dir}/fail' ]; then echo 'tpal: restart-codex: mid-turn' >&2; exit 1; fi`,
      "echo 'tpal: done'"
    ].join("\n"));
    await chmod(bin, 0o755);

    const app = express();
    app.use(express.json());
    app.use(createTpalActionsRouter({ tpalBin: async () => bin, listPanes: async () => PANES }));
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

  async function request(method: "GET" | "POST", url: string, body?: unknown) {
    const response = await fetch(`${baseUrl}${url}`, {
      method,
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
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

  it("lists the pane's client-free actions", async () => {
    const result = await request("GET", "/api/tmux/actions?target=%2512");
    expect(result.status).toBe(200);
    const data = result.json.data as { target: string; header: string; actions: Array<{ name: string }> };
    expect(data.target).toBe("%12");
    expect(data.header).toBe("pane %12 · codex");
    expect(data.actions.map((action) => action.name)).toEqual(["handoff session", "restart codex: yolo mode", "next layout"]);
  });

  it("rejects unknown, remote and legacy targets with 400", async () => {
    for (const target of ["%99", "dk--box--%3", "legacy", ""]) {
      expect((await request("GET", `/api/tmux/actions?target=${encodeURIComponent(target)}`)).status, target).toBe(400);
      expect((await request("POST", "/api/tmux/actions/run", { target, name: "next layout" })).status, target).toBe(400);
    }
    expect(await ranArgv()).toBeNull();
  });

  it("runs only names tpal lists for the pane without a client", async () => {
    for (const name of ["snooze window", "C-a w", "rm -rf ~", "", 3, null]) {
      const result = await request("POST", "/api/tmux/actions/run", { target: "%12", name });
      expect(result.status, String(name)).toBe(400);
      expect(String(result.json.error)).toMatch(/Unknown action/);
    }
    expect(await ranArgv()).toBeNull();

    const result = await request("POST", "/api/tmux/actions/run", { target: "%12", name: "next layout" });
    expect(result.status).toBe(200);
    expect(result.json.data).toEqual({ output: "tpal: done" });
    expect(await ranArgv()).toEqual(["run", "--pane", "%12", "--", "next layout"]);
  });

  it("needs yes for an action with tpal's y/n question", async () => {
    const refused = await request("POST", "/api/tmux/actions/run", { target: "%12", name: "restart codex: yolo mode" });
    expect(refused.status).toBe(400);
    expect(String(refused.json.error)).toContain("no approvals and no sandbox?");
    expect(await ranArgv()).toBeNull();

    const confirmed = await request("POST", "/api/tmux/actions/run", { target: "%12", name: "restart codex: yolo mode", yes: true });
    expect(confirmed.status).toBe(200);
    expect(await ranArgv()).toEqual(["run", "--pane", "%12", "--yes", "--", "restart codex: yolo mode"]);
  });

  it("passes yes only where tpal asks", async () => {
    await request("POST", "/api/tmux/actions/run", { target: "%12", name: "handoff session", yes: true });
    expect(await ranArgv()).toEqual(["run", "--pane", "%12", "--", "handoff session"]);
  });

  it("surfaces tpal's refusal", async () => {
    await writeFile(path.join(dir, "fail"), "");
    const result = await request("POST", "/api/tmux/actions/run", { target: "%12", name: "handoff session" });
    expect(result.status).toBe(502);
    expect(String(result.json.error)).toContain("tpal: restart-codex: mid-turn");
  });

  it("answers 404 when tpal is not installed", async () => {
    bin = null;
    expect((await request("GET", "/api/tmux/actions?target=%2512")).status).toBe(404);
  });

  it("reports the wrapper only when it is executable", async () => {
    expect(await findTpalBin({ ATW_TPAL_BIN: bin! })).toBe(bin);
    expect(await findTpalBin({ ATW_TPAL_BIN: path.join(dir, "listing.json") })).toBeNull();
    expect(await findTpalBin({ ATW_TPAL_BIN: "" })).toBeNull();
  });
});
