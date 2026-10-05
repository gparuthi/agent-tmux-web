import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { TmuxRunner } from "../tmuxAutoZoom.js";
import {
  buildTmuxShowWindowSizeOptionArgs,
  buildTmuxUnpinWindowSizeCommandSequence,
  buildTmuxWindowIdentityArgs,
  parseTmuxWindowIdentity,
  parseTrackedTmuxWindowsFile,
  TmuxWindowSizeGuard
} from "../tmuxWindowSize.js";

type FakeWindow = { panes: string[]; windowSize: string };

// An in-memory tmux server whose window-size option behaves like tmux 3.x: any resize-window pins it manual.
function fakeTmux(windows: Record<string, FakeWindow>, serverPid = { value: "4242" }) {
  const calls: string[][] = [];
  const windowOf = (target: string) => Object.entries(windows).find(([id, window]) => id === target || window.panes.includes(target));
  const run: TmuxRunner = async (args) => {
    calls.push(args);
    const found = windowOf(args[args.indexOf("-t") + 1] ?? "");
    if (!found) {
      throw new Error("can't find window");
    }
    const [windowId, window] = found;
    if (args[0] === "display-message") {
      return `${serverPid.value}\t${windowId}\n`;
    }
    if (args[0] === "show-window-options") {
      return window.windowSize ? `${window.windowSize}\n` : "";
    }
    if (args[0] === "resize-window") {
      window.windowSize = "manual";
      return "";
    }
    if (args[0] === "set-window-option" && args[1] === "-u") {
      window.windowSize = "";
      return "";
    }
    throw new Error(`unexpected tmux ${args.join(" ")}`);
  };
  const changes = () => calls.filter((args) => args[0] === "resize-window" || args[0] === "set-window-option");
  return { run, calls, changes, serverPid };
}

describe("tmux window-size guard helpers", () => {
  it("builds argv for the window identity, its own window-size and the unpin", () => {
    expect(buildTmuxWindowIdentityArgs("%4")).toEqual(["display-message", "-p", "-t", "%4", "#{pid}\t#{window_id}"]);
    expect(buildTmuxShowWindowSizeOptionArgs("%4")).toEqual(["show-window-options", "-v", "-t", "%4", "window-size"]);
    // The unset runs last: resize-window -A alone would leave the window pinned at manual.
    expect(buildTmuxUnpinWindowSizeCommandSequence("%4")).toEqual([
      ["resize-window", "-A", "-t", "%4"],
      ["set-window-option", "-u", "-t", "%4", "window-size"]
    ]);
  });

  it("parses window identities and rejects junk", () => {
    expect(parseTmuxWindowIdentity("4242\t@7\n")).toEqual({ serverPid: "4242", windowId: "@7" });
    expect(parseTmuxWindowIdentity("4242\t%7")).toBeNull();
    expect(parseTmuxWindowIdentity("")).toBeNull();
  });

  it("reads only well-formed tracked windows from the state file", () => {
    expect(parseTrackedTmuxWindowsFile("not json")).toEqual([]);
    expect(parseTrackedTmuxWindowsFile("{}")).toEqual([]);
    expect(parseTrackedTmuxWindowsFile(JSON.stringify([
      { target: "%1", serverPid: "1", windowId: "@1", extra: true },
      { target: "", serverPid: "1", windowId: "@2" },
      { target: "%3", windowId: "@3" },
      null
    ]))).toEqual([{ target: "%1", serverPid: "1", windowId: "@1" }]);
  });
});

describe("TmuxWindowSizeGuard", () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "atw-window-size-"));
    file = path.join(dir, "state", "resized-windows.json");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("unpins only tracked windows, and only while they are manual", async () => {
    const windows: Record<string, FakeWindow> = {
      "@1": { panes: ["%1"], windowSize: "manual" },
      "@2": { panes: ["%2"], windowSize: "manual" },
      "@3": { panes: ["%3"], windowSize: "" }
    };
    const tmux = fakeTmux(windows);
    const guard = new TmuxWindowSizeGuard({ filePath: file, tmux: tmux.run });
    await guard.track("%1");
    await guard.track("%3");

    await guard.heal();

    // @2 is pinned but atw never resized it (the owner may want it pinned); @3 was never left manual.
    expect(tmux.changes()).toEqual([
      ["resize-window", "-A", "-t", "%1"],
      ["set-window-option", "-u", "-t", "%1", "window-size"]
    ]);
    expect(windows["@1"].windowSize).toBe("");
    expect(windows["@2"].windowSize).toBe("manual");

    // A later pin on a tracked window is healed again on the next sweep.
    windows["@1"].windowSize = "manual";
    await guard.heal();
    expect(windows["@1"].windowSize).toBe("");
    expect(guard.tracked().map((entry) => entry.target)).toEqual(["%1", "%3"]);
  });

  it("recovers tracked windows from the state file after a restart", async () => {
    const windows: Record<string, FakeWindow> = {
      "@1": { panes: ["%1"], windowSize: "" },
      "@2": { panes: ["%2"], windowSize: "" }
    };
    const tmux = fakeTmux(windows);
    await new TmuxWindowSizeGuard({ filePath: file, tmux: tmux.run }).track("%1");
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual([{ target: "%1", serverPid: "4242", windowId: "@1" }]);

    // The old server crashed before cleaning up; a fresh guard heals from disk alone.
    windows["@1"].windowSize = "manual";
    windows["@2"].windowSize = "manual";
    const restarted = new TmuxWindowSizeGuard({ filePath: file, tmux: tmux.run });
    await restarted.load();
    await restarted.heal();

    expect(windows["@1"].windowSize).toBe("");
    expect(windows["@2"].windowSize).toBe("manual");
  });

  it("forgets windows that are gone or now belong to another tmux server", async () => {
    const windows: Record<string, FakeWindow> = {
      "@1": { panes: ["%1"], windowSize: "manual" },
      "@2": { panes: ["%2"], windowSize: "manual" }
    };
    const tmux = fakeTmux(windows);
    const guard = new TmuxWindowSizeGuard({ filePath: file, tmux: tmux.run });
    await guard.track("%1");
    await guard.track("%2");

    // tmux restarted: same ids, different windows; then %2's window closes.
    tmux.serverPid.value = "5555";
    delete windows["@2"];
    await guard.heal();

    expect(tmux.changes()).toEqual([]);
    expect(windows["@1"].windowSize).toBe("manual");
    expect(guard.tracked()).toEqual([]);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual([]);
  });

  it("keeps a window tracked when unpinning it fails, and retries next sweep", async () => {
    const windows: Record<string, FakeWindow> = { "@1": { panes: ["%1"], windowSize: "manual" } };
    const tmux = fakeTmux(windows);
    let failUnset = true;
    const run: TmuxRunner = async (args) => {
      if (failUnset && args[0] === "set-window-option") {
        throw new Error("server busy");
      }
      return tmux.run(args);
    };
    const guard = new TmuxWindowSizeGuard({ filePath: null, tmux: run });
    await guard.track("%1");

    await guard.heal();
    expect(windows["@1"].windowSize).toBe("manual");
    expect(guard.tracked()).toHaveLength(1);

    failUnset = false;
    await guard.heal();
    expect(windows["@1"].windowSize).toBe("");
  });
});
