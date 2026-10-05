import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildBrowserRawTerminalPolicy,
  buildProcessTtyListArgs,
  buildPtyResizeArgs,
  buildScriptArgsForShellCommand,
  buildScriptArgsForTmuxAttach,
  buildScriptSpawn,
  buildTmuxAttachShellCommand,
  buildTmuxGroupedAttachShellCommand,
  findRawTerminalPtyTty,
  isTmuxRawSessionName,
  normalizeTerminalSize
} from "../terminal.js";

describe("browser tmux terminal helpers", () => {
  it("builds util-linux script args for attaching to tmux inside a pty", () => {
    expect(buildScriptArgsForTmuxAttach("codex-ui", {}, undefined, "linux")).toEqual([
      "-qfec",
      "tmux attach-session -t codex-ui",
      "/dev/null"
    ]);
    expect(buildScriptArgsForTmuxAttach("codex-ui", { ignoreSize: true }, undefined, "linux")).toEqual([
      "-qfec",
      "tmux attach-session -f ignore-size -t codex-ui",
      "/dev/null"
    ]);
  });

  it("sets the script pty size before attaching a browser raw terminal", () => {
    expect(buildScriptArgsForTmuxAttach("codex-ui", {}, { cols: 132, rows: 36 }, "linux")).toEqual([
      "-qfec",
      "stty cols 132 rows 36; tmux attach-session -t codex-ui",
      "/dev/null"
    ]);
  });

  it("lets browser raw terminals size tmux as a normal client even when another client is attached", () => {
    const policy = buildBrowserRawTerminalPolicy({ hasAttachedClients: true });

    expect(policy).toEqual({ attachOptions: {} });
    expect(buildScriptArgsForTmuxAttach("codex-ui", policy.attachOptions, undefined, "linux")).toEqual([
      "-qfec",
      "tmux attach-session -t codex-ui",
      "/dev/null"
    ]);
  });

  it("uses BSD script argument order on macOS", () => {
    expect(buildScriptArgsForTmuxAttach("codex-ui", {}, { cols: 132, rows: 36 }, "darwin")).toEqual([
      "-qF",
      "/dev/null",
      "sh",
      "-c",
      "stty cols 132 rows 36; tmux attach-session -t codex-ui"
    ]);
    expect(buildScriptArgsForShellCommand("true", "linux")).toEqual(["-qfec", "true", "/dev/null"]);
  });

  it("spawns util-linux script directly and pipes BSD script stdin through bash", () => {
    expect(buildScriptSpawn("tmux ls", "linux")).toEqual({ file: "script", args: ["-qfec", "tmux ls", "/dev/null"] });
    expect(buildScriptSpawn("tmux ls", "darwin")).toEqual({
      file: "/bin/bash",
      args: ["-c", 'exec script "$@" < <(exec cat)', "atw-script", "-qF", "/dev/null", "sh", "-c", "tmux ls"]
    });
  });

  it("keeps the browser off windows that another client is viewing", () => {
    const policy = buildBrowserRawTerminalPolicy({ hasAttachedClients: true, windowViewedByOtherClients: true });

    expect(policy).toEqual({ attachOptions: { ignoreSize: true } });
  });

  it("attaches raw terminals through a grouped session focused on one pane", () => {
    const target = { baseSession: "main", rawSession: "atw-raw-1a2b", windowId: "@16", paneId: "%38" };

    expect(buildTmuxGroupedAttachShellCommand(target)).toBe(
      "tmux new-session -f active-pane -t main -s atw-raw-1a2b ';' "
      + "set-option -t atw-raw-1a2b destroy-unattached on ';' "
      + "select-window -t atw-raw-1a2b:@16 ';' "
      + "select-pane -t '%38'"
    );
    expect(buildTmuxGroupedAttachShellCommand(target, { ignoreSize: true }, { cols: 100, rows: 30 })).toBe(
      "stty cols 100 rows 30; tmux new-session -f active-pane,ignore-size -t main -s atw-raw-1a2b ';' "
      + "set-option -t atw-raw-1a2b destroy-unattached on ';' "
      + "select-window -t atw-raw-1a2b:@16 ';' "
      + "select-pane -t '%38'"
    );
  });

  it("routes grouped attaches for shimmed container sessions with in-container ids", () => {
    expect(buildTmuxGroupedAttachShellCommand({
      baseSession: "dk--box--main",
      rawSession: "atw-raw-ff00",
      windowId: "@2",
      paneId: "%5"
    })).toBe(
      "tmux new-session -f active-pane -t dk--box--main -s atw-raw-ff00 ';' "
      + "set-option -t atw-raw-ff00 destroy-unattached on ';' "
      + "select-window -t atw-raw-ff00:@2 ';' "
      + "select-pane -t '%5'"
    );
  });

  it("recognizes atw's grouped raw sessions, including shim-prefixed ones", () => {
    expect(isTmuxRawSessionName("atw-raw-1a2b")).toBe(true);
    expect(isTmuxRawSessionName("dk--box--atw-raw-1a2b")).toBe(true);
    expect(isTmuxRawSessionName("main")).toBe(false);
    expect(isTmuxRawSessionName("my-atw-raw-notes")).toBe(false);
  });

  it("shell-quotes tmux session names before embedding them in script commands", () => {
    expect(buildTmuxAttachShellCommand("codex work's")).toBe("tmux attach-session -t 'codex work'\\''s'");
    expect(buildTmuxAttachShellCommand("codex work's", { ignoreSize: true })).toBe("tmux attach-session -f ignore-size -t 'codex work'\\''s'");
  });

  it("normalizes browser terminal dimensions to a safe tmux size", () => {
    expect(normalizeTerminalSize(10, 4)).toEqual({ cols: 20, rows: 8 });
    expect(normalizeTerminalSize(999, 999)).toEqual({ cols: 240, rows: 80 });
    expect(normalizeTerminalSize(132, 36)).toEqual({ cols: 132, rows: 36 });
  });

  it("finds the raw client's own pty under the script process", () => {
    expect(buildProcessTtyListArgs()).toEqual(["-A", "-o", "pid=,ppid=,tty="]);
    // macOS under launchd: script and the stdin relay (cat) have no terminal; sh and tmux sit on script's pty.
    expect(findRawTerminalPtyTty([
      "  1     0 ??",
      "100     1 ??",
      "200   100 ??",
      "201   200 ??",
      "202   200 ttys021",
      "203   202 ttys021",
      "300     1 ttys004"
    ].join("\n"), 200)).toBe("/dev/ttys021");
    // Started from a terminal: the relay inherits atw's terminal, which must never be resized.
    expect(findRawTerminalPtyTty("200 100 ttys004\n201 200 ttys004\n202 200 ttys021\n", 200)).toBe("/dev/ttys021");
    expect(findRawTerminalPtyTty("200 100 ?\n202 200 pts/3\n", 200)).toBe("/dev/pts/3");
    expect(findRawTerminalPtyTty("200 100 ??\n201 200 ??\n300 1 ttys021\n", 200)).toBeNull();
  });

  it("resizes a pty with the platform's stty flag", () => {
    expect(buildPtyResizeArgs("/dev/ttys021", { cols: 44, rows: 30 }, "darwin")).toEqual(["-f", "/dev/ttys021", "cols", "44", "rows", "30"]);
    expect(buildPtyResizeArgs("/dev/pts/3", { cols: 44, rows: 30 }, "linux")).toEqual(["-F", "/dev/pts/3", "cols", "44", "rows", "30"]);
  });

  it("never resizes tmux windows from raw attaches or captures", () => {
    const serverDir = join(process.cwd(), "src/server");
    const index = readFileSync(join(serverDir, "index.ts"), "utf8");
    const attach = buildTmuxGroupedAttachShellCommand({ baseSession: "main", rawSession: "atw-raw-1a2b", windowId: "@1", paneId: "%1" }, {}, { cols: 44, rows: 30 });

    expect(attach).not.toMatch(/resize-window|window-size/);
    expect(index).not.toMatch(/resize-window|window-size|resizeTmuxWindow|restoreTmuxWindowState/);
    // The window-size guard's unpin is the only resize-window atw may run.
    const resizers = readdirSync(serverDir)
      .filter((name) => name.endsWith(".ts") && readFileSync(join(serverDir, name), "utf8").includes('"resize-window"'));
    expect(resizers).toEqual(["tmuxWindowSize.ts"]);
  });
});
