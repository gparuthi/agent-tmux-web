import { describe, expect, it } from "vitest";

import {
  buildBrowserRawTerminalPolicy,
  buildScriptArgsForShellCommand,
  buildScriptArgsForTmuxAttach,
  buildScriptSpawn,
  buildTmuxAttachShellCommand,
  buildTmuxGroupedAttachShellCommand,
  buildTmuxCaptureSizeFromClientDimensions,
  buildTmuxDisplayWindowSizeArgs,
  buildTmuxRestoreManualSizeArgs,
  buildTmuxRestoreWindowStateCommandSequence,
  buildTmuxSetWindowSizeOptionArgs,
  buildTmuxShowWindowSizeOptionArgs,
  isSameTerminalSize,
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

  it("lets browser raw terminals drive tmux size even when another client is attached", () => {
    const policy = buildBrowserRawTerminalPolicy({ hasAttachedClients: true });

    expect(policy.attachOptions).toEqual({});
    expect(policy.resizeTmuxWindowOnAttach).toBe(true);
    expect(policy.resizeTmuxWindow).toBe(true);
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

    expect(policy.attachOptions).toEqual({ ignoreSize: true });
    expect(policy.resizeTmuxWindowOnAttach).toBe(false);
    expect(policy.resizeTmuxWindow).toBe(false);
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

  it("detects unchanged terminal dimensions", () => {
    expect(isSameTerminalSize({ cols: 132, rows: 36 }, { cols: 132, rows: 36 })).toBe(true);
    expect(isSameTerminalSize({ cols: 132, rows: 36 }, { cols: 133, rows: 36 })).toBe(false);
    expect(isSameTerminalSize({ cols: 132, rows: 36 }, { cols: 132, rows: 37 })).toBe(false);
  });

  it("maps the complete TTY viewport to tmux rows and columns", () => {
    expect(buildTmuxCaptureSizeFromClientDimensions(320, 744)).toEqual({ cols: 36, rows: 40 });
    expect(buildTmuxCaptureSizeFromClientDimensions(390, 744)).toEqual({ cols: 44, rows: 40 });
    expect(buildTmuxCaptureSizeFromClientDimensions(640, 420)).toEqual({ cols: 75, rows: 22 });
    expect(buildTmuxCaptureSizeFromClientDimensions(1280, 960)).toEqual({ cols: 154, rows: 52 });
    expect(buildTmuxCaptureSizeFromClientDimensions(2200, 2200)).toEqual({ cols: 240, rows: 80 });
  });

  it("builds commands for restoring tmux window size state after detach", () => {
    expect(buildTmuxDisplayWindowSizeArgs("codex-ui")).toEqual([
      "display-message",
      "-p",
      "-t",
      "codex-ui",
      "#{window_width} #{window_height}"
    ]);
    expect(buildTmuxShowWindowSizeOptionArgs("codex-ui")).toEqual([
      "show-window-options",
      "-v",
      "-t",
      "codex-ui",
      "window-size"
    ]);
    expect(buildTmuxSetWindowSizeOptionArgs("codex-ui", "latest")).toEqual([
      "set-window-option",
      "-t",
      "codex-ui",
      "window-size",
      "latest"
    ]);
    expect(buildTmuxRestoreManualSizeArgs("codex-ui", { cols: 132, rows: 36 })).toEqual([
      "resize-window",
      "-t",
      "codex-ui",
      "-x",
      "132",
      "-y",
      "36"
    ]);
    expect(
      buildTmuxRestoreWindowStateCommandSequence("codex-ui", {
        size: { cols: 132, rows: 36 },
        windowSizeOption: "latest"
      })
    ).toEqual([
      ["resize-window", "-t", "codex-ui", "-x", "132", "-y", "36"],
      ["set-window-option", "-t", "codex-ui", "window-size", "latest"]
    ]);
  });
});
