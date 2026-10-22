import { execFile, spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  buildCodexTmuxCommand,
  buildOpenCodeSqliteArgs,
  buildTmuxCancelModeArgs,
  buildTmuxCreateSessionArgs,
  buildTmuxCapturePaneArgs,
  buildTmuxKillPaneArgs,
  buildTmuxKillSessionArgs,
  buildTmuxListPanesArgs,
  buildTmuxPaneDisplayName,
  buildTmuxPaneLabel,
  buildTmuxViewerCountArgs,
  captureTmuxPane,
  captureTmuxPaneView,
  displayTmuxPaneCommand,
  listTmuxSessions,
  parseTmuxPanes,
  parseTmuxViewerCounts,
  parseTmuxWindowSnooze,
  closeTmuxPane,
  resolveClosableTmuxPane,
  resolveTmuxPaneEntry,
  resolveTmuxSessionName,
  isAllowedTmuxKey,
  sendTmuxKey,
  sendTmuxText,
  shortenTmuxPanePath,
  splitTmuxPaneTarget,
  TMUX_LIST_PANES_FORMAT,
  buildTmuxInterruptKeysArgs,
  buildTmuxPaneInModeArgs,
  buildTmuxLiteralSendArgs,
  buildTmuxSendKeyArgs,
  buildTmuxSubmitKeysArgs,
  buildTmuxToolCommand,
  chunkTmuxLiteralText,
  buildTmuxNewSessionArgs,
  detectTmuxInterruptKey,
  detectTmuxSubmitKey,
  extractOpenCodeSessionId,
  tmuxSubmitDelayMs,
  normalizeTmuxSessionName,
  normalizeTmuxCaptureLines,
  normalizeTmuxToolId,
  isOpenCodeFullTuiPane,
  matchOpenCodePaneSession,
  parseTmuxPaneMetadata,
  parseOpenCodeSessionStates,
  parseTmuxSessions,
  parseTmuxTools,
  readOpenCodeTextStream,
  renderOpenCodeTextStream,
  splitDisplayLineAtColumn,
  splitOpenCodeTuiCapture,
  trimTmuxAnsiCapture,
  trimTmuxCapture
} from "../tmux.js";
import { TMUX_CAPTURE_HISTORY_LINES } from "../../shared/api.js";

const execFileAsync = promisify(execFile);

describe("parseTmuxSessions", () => {
  it("parses session names, window counts, timestamps, and attached state", () => {
    const output = [
      "chat-interface: 1 windows (created Tue May 12 20:10:22 2026) (attached)",
      "kartbite: 3 windows (created Sun May 10 15:10:14 2026)",
      "dev:api: 2 windows (created Wed May 13 00:02:01 2026)"
    ].join("\n");

    expect(parseTmuxSessions(output)).toEqual([
      {
        name: "chat-interface",
        windows: 1,
        created: "Tue May 12 20:10:22 2026",
        attached: true,
        clientCount: 1
      },
      {
        name: "kartbite",
        windows: 3,
        created: "Sun May 10 15:10:14 2026",
        attached: false,
        clientCount: 0
      },
      {
        name: "dev:api",
        windows: 2,
        created: "Wed May 13 00:02:01 2026",
        attached: false,
        clientCount: 0
      }
    ]);
  });

  it("parses formatted session rows with activity metadata", () => {
    const output = [
      "agent-tmux-web\t1\t1779925303\t0\t1779925303\topencode\t1517\t/home/dev/codex-web\tOC | Task\twith tab",
      "radchenko-business\t2\t1780351746\t2\t1782255086\tzsh\t2001\t/home/dev"
    ].join("\n");

    expect(parseTmuxSessions(output)).toEqual([
      {
        name: "agent-tmux-web",
        windows: 1,
        created: "2026-05-27T23:41:43.000Z",
        createdAtMs: 1779925303000,
        attached: false,
        clientCount: 0,
        panePid: 1517,
        currentPath: "/home/dev/codex-web",
        activityAtMs: 1779925303000,
        currentCommand: "opencode",
        paneTitle: "OC | Task\twith tab"
      },
      {
        name: "radchenko-business",
        windows: 2,
        created: "2026-06-01T22:09:06.000Z",
        createdAtMs: 1780351746000,
        attached: true,
        clientCount: 2,
        panePid: 2001,
        currentPath: "/home/dev",
        activityAtMs: 1782255086000,
        currentCommand: "zsh"
      }
    ]);
  });

  it("returns an empty list for no server output", () => {
    expect(parseTmuxSessions("no server running on /tmp/tmux-1000/default")).toEqual([]);
    expect(parseTmuxSessions("")).toEqual([]);
  });
});

describe("OpenCode harness status", () => {
  it("extracts only valid explicit session ids from process arguments", () => {
    expect(extractOpenCodeSessionId(["opencode", "-s", "ses_06e992681ffewzWD1b0KC1mDa9", "--auto"]))
      .toBe("ses_06e992681ffewzWD1b0KC1mDa9");
    expect(extractOpenCodeSessionId(["opencode", "--session", "ses_abc123"])).toBe("ses_abc123");
    expect(extractOpenCodeSessionId(["opencode", "--auto"])).toBeNull();
    expect(extractOpenCodeSessionId(["opencode", "-s", "unsafe id"])).toBeNull();
  });

  it("maps native question, running, and completed states to status lights", () => {
    const states = parseOpenCodeSessionStates(JSON.stringify([
      { sessionId: "ses_choice", messageId: "msg_1", completedAt: null, choicePending: 1 },
      { sessionId: "ses_running", messageId: "msg_2", completedAt: null, choicePending: 0 },
      { sessionId: "ses_idle", messageId: "msg_3", completedAt: 123, choicePending: 0 },
      { sessionId: "ses_empty", messageId: null, completedAt: null, choicePending: 0 }
    ]));

    expect(states.get("ses_choice")).toEqual({ kind: "blocked", title: "Asking a question", source: "atw" });
    expect(states.get("ses_running")).toEqual({ kind: "working", title: "Working", source: "atw" });
    expect(states.get("ses_idle")).toEqual({ kind: "idle", title: "Idle", source: "atw" });
    expect(states.get("ses_empty")).toEqual({ kind: "idle", title: "Idle", source: "atw" });
  });

  it("matches an automatic OpenCode process only to one root session title in its directory", () => {
    const sessions = [
      { id: "ses_active", directory: "/workspace/app", title: "Improving TTY formatting across harnesses" },
      { id: "ses_other", directory: "/workspace/app", title: "Older task" },
      { id: "ses_elsewhere", directory: "/workspace/other", title: "Improving TTY formatting across harnesses" }
    ];

    expect(matchOpenCodePaneSession(sessions, "/workspace/app", "OC | Improving TTY formatting across harne..."))
      .toBe("ses_active");
    expect(matchOpenCodePaneSession(sessions, "/workspace/app", "OC | Older task")).toBe("ses_other");
    expect(matchOpenCodePaneSession(sessions, "/workspace/app", "OpenCode")).toBeNull();
    expect(matchOpenCodePaneSession([
      ...sessions,
      { id: "ses_ambiguous", directory: "/workspace/app", title: "Improving TTY formatting across harnesses again" }
    ], "/workspace/app", "OC | Improving TTY formatting across harne...")).toBeNull();
  });

  it("renders persisted user and assistant text without loading tool payloads", () => {
    expect(renderOpenCodeTextStream(JSON.stringify([
      { messageId: "msg_user", role: "user", text: "First request" },
      { messageId: "msg_assistant_1", role: "assistant", text: "Progress update" },
      { messageId: "msg_assistant_2", role: "assistant", text: "Final answer" },
      { messageId: "msg_tool", role: "assistant", text: null },
      { messageId: "msg_user_2", role: "user", text: "Follow-up" }
    ]))).toBe([
      "You",
      "",
      "First request",
      "",
      "Assistant",
      "",
      "Progress update",
      "",
      "Final answer",
      "",
      "You",
      "",
      "Follow-up"
    ].join("\n"));
    expect(renderOpenCodeTextStream("not json")).toBeNull();
    expect(renderOpenCodeTextStream(JSON.stringify([
      { messageId: "msg_code", role: "assistant", text: "  const indented = true;\nvalue  " }
    ]))).toBe("Assistant\n\n  const indented = true;\nvalue  ");
  });

  it("reads OpenCode text read-only and returns revisions, unchanged responses, and append deltas", async () => {
    const dataRoot = await mkdtemp(path.join(tmpdir(), "agent-tmux-opencode-"));
    const databaseDirectory = path.join(dataRoot, "opencode");
    const databasePath = path.join(databaseDirectory, "opencode.db");
    const originalDataHome = process.env.XDG_DATA_HOME;
    await mkdir(databaseDirectory);
    process.env.XDG_DATA_HOME = dataRoot;

    try {
      await execFileAsync("sqlite3", [databasePath, `
        CREATE TABLE message (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          time_created INTEGER NOT NULL,
          time_updated INTEGER NOT NULL,
          data TEXT NOT NULL
        );
        CREATE TABLE part (
          id TEXT PRIMARY KEY,
          message_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          time_created INTEGER NOT NULL,
          time_updated INTEGER NOT NULL,
          data TEXT NOT NULL
        );
        INSERT INTO message VALUES (
          'msg_user', 'ses_TestReadOnly', 1, 1, '{"role":"user"}'
        );
        INSERT INTO part VALUES (
          'prt_user', 'msg_user', 'ses_TestReadOnly', 1, 1,
          '{"type":"text","text":"First request"}'
        );
        INSERT INTO part VALUES (
          'prt_tool', 'msg_user', 'ses_TestReadOnly', 2, 2,
          '{"type":"tool","payload":"excluded"}'
        );
      `]);

      const initial = await readOpenCodeTextStream("ses_TestReadOnly");
      expect(initial).toMatchObject({
        output: "You\n\nFirst request",
        outputAppend: false,
        outputUnchanged: false
      });
      expect(initial?.revision).toMatch(/^\d+:\d+:\d+$/);

      expect(await readOpenCodeTextStream("ses_TestReadOnly", initial?.revision)).toEqual({
        output: null,
        outputAppend: false,
        outputUnchanged: true,
        revision: initial?.revision
      });

      await execFileAsync("sqlite3", [databasePath, `
        UPDATE part
        SET time_updated = 3,
            data = '{"type":"text","text":"First request\\ncontinued"}'
        WHERE id = 'prt_user';
      `]);
      const appended = await readOpenCodeTextStream("ses_TestReadOnly", initial?.revision);
      expect(appended).toMatchObject({
        output: "\ncontinued",
        outputAppend: true,
        outputUnchanged: false
      });
      expect(appended?.revision).not.toBe(initial?.revision);

      process.env.XDG_DATA_HOME = path.join(dataRoot, "missing");
      await expect(readOpenCodeTextStream("ses_MissingDatabase")).rejects.toThrow();
      await expect(access(path.join(dataRoot, "missing", "opencode", "opencode.db"))).rejects.toThrow();
    } finally {
      if (originalDataHome === undefined) {
        delete process.env.XDG_DATA_HOME;
      } else {
        process.env.XDG_DATA_HOME = originalDataHome;
      }
      await rm(dataRoot, { force: true, recursive: true });
    }
  });
});

describe("tmux command builders", () => {
  it("normalizes user-entered session names for tmux", () => {
    expect(normalizeTmuxSessionName("Kartbite Coding!")).toBe("kartbite-coding");
    expect(normalizeTmuxSessionName("")).toBe("codex");
  });

  it("normalizes configured CLI tool ids", () => {
    expect(normalizeTmuxToolId("Claude Code!")).toBe("claude-code");
    expect(normalizeTmuxToolId("")).toBe("");
  });

  it("builds detached session args with an optional working directory", () => {
    expect(buildTmuxNewSessionArgs("agent-ui", "/workspace/agent-tmux-web")).toEqual([
      "new-session",
      "-d",
      "-x",
      "160",
      "-y",
      "40",
      "-s",
      "agent-ui",
      "-c",
      "/workspace/agent-tmux-web"
    ]);
  });

  it("gives app-created panes enough history without lowering a larger tmux setting", () => {
    expect(buildTmuxCreateSessionArgs("agent-ui", "/workspace", 2000)).toEqual([
      "set-option", "-g", "history-limit", String(TMUX_CAPTURE_HISTORY_LINES), ";",
      "new-session", "-d", "-x", "160", "-y", "40", "-s", "agent-ui", "-c", "/workspace"
    ]);
    expect(buildTmuxCreateSessionArgs("agent-ui", null, null).slice(0, 7)).toEqual([
      "start-server", ";", "set-option", "-g", "history-limit", String(TMUX_CAPTURE_HISTORY_LINES), ";"
    ]);
    expect(buildTmuxCreateSessionArgs("agent-ui", null, 10_000)).toEqual(
      buildTmuxNewSessionArgs("agent-ui")
    );
  });

  it("normalizes deep capture requests to finite bounded whole rows", () => {
    expect(normalizeTmuxCaptureLines(Number.NaN)).toBe(TMUX_CAPTURE_HISTORY_LINES);
    expect(normalizeTmuxCaptureLines(Number.POSITIVE_INFINITY)).toBe(TMUX_CAPTURE_HISTORY_LINES);
    expect(normalizeTmuxCaptureLines(-10)).toBe(20);
    expect(normalizeTmuxCaptureLines(250.9)).toBe(250);
    expect(normalizeTmuxCaptureLines(50_000)).toBe(TMUX_CAPTURE_HISTORY_LINES);
  });

  it("provides generic default agent CLI launchers", () => {
    const tools = parseTmuxTools(undefined);
    expect(tools.map((tool) => tool.id)).toEqual([
      "opencode",
      "codex",
      "claude",
      "gemini",
      "copilot",
      "cursor",
      "qwen",
      "cline",
      "aider",
      "goose",
      "amp"
    ]);
    expect(tools.find((tool) => tool.id === "codex")?.modes).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "auto", args: "--sandbox workspace-write --ask-for-approval on-request" }),
      expect.objectContaining({ id: "yolo", args: "--dangerously-bypass-approvals-and-sandbox", dangerous: true })
    ]));
    expect(tools.find((tool) => tool.id === "opencode")?.modes?.map((mode) => mode.id)).toEqual(["default", "auto"]);
    expect(tools.find((tool) => tool.id === "claude")?.label).toBe("Claude Code");
    expect(tools.find((tool) => tool.id === "cline")?.command).toBe("cline --tui");
    expect(tools.find((tool) => tool.id === "goose")?.command).toBe("goose session");
  });

  it("parses configured generic tmux tools from JSON", () => {
    expect(parseTmuxTools(JSON.stringify([
      { label: "Gemini CLI", command: "gemini", defaultSessionName: "gemini work" },
      {
        id: "claude-plan",
        label: "Claude Plan",
        command: "claude",
        modes: [{
          label: "Plan",
          args: "--permission-mode plan",
          defaultEnabled: true,
          exclusiveGroup: "Permission Mode",
          description: "Read-only planning",
          dangerous: true
        }]
      }
    ]))).toEqual([
      {
        id: "gemini-cli",
        label: "Gemini CLI",
        command: "gemini",
        defaultSessionName: "gemini-work"
      },
      {
        id: "claude-plan",
        label: "Claude Plan",
        command: "claude",
        defaultSessionName: "claude-plan",
        modes: [
          {
            id: "plan",
            label: "Plan",
            args: "--permission-mode plan",
            defaultEnabled: true,
            exclusiveGroup: "permission-mode",
            description: "Read-only planning",
            dangerous: true
          }
        ]
      }
    ]);
  });

  it("keeps empty-argument default choices for custom mode groups", () => {
    expect(parseTmuxTools(JSON.stringify([{
      id: "custom-agent",
      label: "Custom Agent",
      command: "custom-agent",
      modes: [{
        id: "default",
        label: "Default",
        args: "",
        defaultEnabled: true,
        exclusiveGroup: "permissions"
      }]
    }]))[0]?.modes).toEqual([{
      id: "default",
      label: "Default",
      args: "",
      defaultEnabled: true,
      exclusiveGroup: "permissions"
    }]);
  });

  it("builds a plain Codex command for opening inside tmux", () => {
    expect(
      buildCodexTmuxCommand({
        cwd: "/workspace/project",
        model: "gpt-5.5"
      })
    ).toBe("codex");
  });

  it("builds a generic CLI tool command for opening inside tmux", () => {
    expect(buildTmuxToolCommand({ command: "claude" })).toBe("claude");
    expect(buildTmuxToolCommand({ command: "gemini --sandbox" })).toBe("gemini --sandbox");
    expect(buildTmuxToolCommand({
      command: "opencode",
      modes: [{ id: "auto", label: "Auto", args: "--auto", defaultEnabled: true }]
    })).toBe("opencode --auto");
    expect(buildTmuxToolCommand({
      command: "opencode",
      modes: [{ id: "auto", label: "Auto", args: "--auto", defaultEnabled: true }]
    }, ["auto"])).toBe("opencode --auto");
    expect(buildTmuxToolCommand({
      command: "opencode",
      modes: [{ id: "auto", label: "Auto", args: "--auto", defaultEnabled: true }]
    }, [])).toBe("opencode");
    expect(buildTmuxToolCommand({
      command: "codex",
      modes: [{ id: "yolo", label: "Yolo", args: "--yolo" }]
    }, ["yolo"])).toBe("codex --yolo");
    expect(buildTmuxToolCommand({
      command: "codex",
      modes: [
        { id: "default", label: "Default", args: "", defaultEnabled: true, exclusiveGroup: "permissions" },
        { id: "auto", label: "Auto", args: "--full-auto", exclusiveGroup: "permissions" },
        { id: "yolo", label: "Yolo", args: "--yolo", exclusiveGroup: "permissions" }
      ]
    }, ["auto", "yolo"])).toBe("codex --yolo");
  });

  it("builds kill-session args for destroying a tmux session", () => {
    expect(buildTmuxKillSessionArgs("codex-ui")).toEqual(["kill-session", "-t", "codex-ui"]);
  });

  it("allows only the key strip's named tmux keys", () => {
    for (const key of ["Escape", "Tab", "Enter", "Up", "Down", "Left", "Right", "C-a", "C-d", "C-z", "C-Up", "M-Left", "M-b", "M-B", "M-.", "M-;", "M-~"]) {
      expect(isAllowedTmuxKey(key), key).toBe(true);
    }
    for (const key of ["", "C-A", "C-", "C-ab", "C-1", "C-Escape", "M-", "M- ", "M-ab", "M-\u00e9", "M-Escape", "S-Up", "C-M-a", "escape", "Enter ", " Enter", "PageUp", "F1", "a", "Enter;", "-X", "send-keys", 4, null, undefined]) {
      expect(isAllowedTmuxKey(key), String(key)).toBe(false);
    }
  });

  it("builds a single send-keys argv for an allowed key and rejects the rest with 400", () => {
    expect(buildTmuxSendKeyArgs("%12", "C-d")).toEqual(["send-keys", "-t", "%12", "C-d"]);
    expect(buildTmuxSendKeyArgs("%12", "Escape")).toEqual(["send-keys", "-t", "%12", "Escape"]);
    expect(buildTmuxSendKeyArgs("%12", "M-;")).toEqual(["send-keys", "-t", "%12", "M-\\;"]);
    expect(() => buildTmuxSendKeyArgs("%12", "C-d; kill-server")).toThrow(/Unsupported tmux key/);
    try {
      buildTmuxSendKeyArgs("%12", "-X");
      expect.unreachable();
    } catch (error) {
      expect((error as { statusCode?: number }).statusCode).toBe(400);
    }
  });

  it("sends literal text with any trailing semicolons as hex keys", () => {
    expect(buildTmuxLiteralSendArgs("%12", "/rename a;b")).toEqual([["send-keys", "-t", "%12", "-l", "/rename a;b"]]);
    expect(buildTmuxLiteralSendArgs("%12", "/rename x\\;")).toEqual([
      ["send-keys", "-t", "%12", "-l", "/rename x\\"],
      ["send-keys", "-t", "%12", "-H", "3b"]
    ]);
    expect(buildTmuxLiteralSendArgs("%12", ";;")).toEqual([["send-keys", "-t", "%12", "-H", "3b", "3b"]]);
  });

  it("closes only an exact listed pane target with kill-pane", () => {
    const entry = (name: string, extra: Record<string, unknown> = {}) => ({
      name, session: "main", windows: 1, created: "", attached: false, clientCount: 0, ...extra
    });
    const entries = [entry("%12", { paneId: "%12" }), entry("box--%3", { paneId: "%3" }), entry("legacy")];
    expect(buildTmuxKillPaneArgs("%12")).toEqual(["kill-pane", "-t", "%12"]);
    expect(resolveClosableTmuxPane(entries, "%12").name).toBe("%12");
    expect(resolveClosableTmuxPane(entries, "box--%3").name).toBe("box--%3");
    for (const requested of ["%99", "main", "legacy", "%12 ", "", 12, null, undefined]) {
      expect(() => resolveClosableTmuxPane(entries, requested), String(requested)).toThrow(/Unknown tmux pane/);
    }
    try {
      resolveClosableTmuxPane(entries, "main");
      expect.unreachable();
    } catch (error) {
      expect((error as { statusCode?: number }).statusCode).toBe(400);
    }
  });

  it("builds pane mode detection and cancel args", () => {
    expect(buildTmuxPaneInModeArgs("codex-ui")).toEqual(["display-message", "-p", "-t", "codex-ui", "#{pane_in_mode}"]);
    expect(buildTmuxCancelModeArgs("codex-ui")).toEqual(["send-keys", "-t", "codex-ui", "-X", "cancel"]);
  });

  it("submits tmux input with the named Enter key", () => {
    expect(buildTmuxSubmitKeysArgs("codex-ui")).toEqual(["send-keys", "-t", "codex-ui", "Enter"]);
    expect(buildTmuxSubmitKeysArgs("codex-ui", "tab")).toEqual(["send-keys", "-t", "codex-ui", "Tab"]);
    expect(buildTmuxSubmitKeysArgs("codex-ui", "codex-enter")).toEqual(["send-keys", "-t", "codex-ui", "Enter"]);
  });

  it("submits Codex TUI panes with a delayed Enter", () => {
    expect(detectTmuxSubmitKey("│ >_ OpenAI Codex (v0.130.0) │\n› Use /skills to list available skills")).toBe("codex-enter");
    expect(detectTmuxSubmitKey("developer in ~/work/project\n❯")).toBe("enter");
  });

  it("detects the right interrupt key for Codex and shell panes", () => {
    expect(detectTmuxInterruptKey("│ >_ OpenAI Codex (v0.130.0) │\n• Working (1s • esc to interrupt)")).toBe("escape");
    expect(detectTmuxInterruptKey("sleep 30\n")).toBe("ctrl-c");
    expect(buildTmuxInterruptKeysArgs("codex-ui", "escape")).toEqual(["send-keys", "-t", "codex-ui", "Escape"]);
    expect(buildTmuxInterruptKeysArgs("codex-ui", "ctrl-c")).toEqual(["send-keys", "-t", "codex-ui", "C-c"]);
  });

  it("delays tmux submission so panes process pasted text before Enter", () => {
    expect(tmuxSubmitDelayMs("tab", "Test")).toBeGreaterThanOrEqual(250);
    expect(tmuxSubmitDelayMs("codex-enter", "Test")).toBeGreaterThanOrEqual(250);
    expect(tmuxSubmitDelayMs("enter", "printf ok")).toBeGreaterThanOrEqual(250);
    expect(tmuxSubmitDelayMs("codex-enter", "")).toBe(0);
    expect(tmuxSubmitDelayMs("enter", "")).toBe(0);
  });

  it("chunks large tmux literal sends without splitting surrogate pairs", () => {
    const chunks = chunkTmuxLiteralText(`abcd🙂efgh`, 5);

    expect(chunks).toEqual(["abcd", "🙂efg", "h"]);
    expect(chunkTmuxLiteralText("abcdef", 3)).toEqual(["abc", "def"]);
    expect(() => chunkTmuxLiteralText("abc", 0)).toThrow("maxChunkLength");
  });

  it("removes terminal-only blank rows without changing captured history", () => {
    expect(trimTmuxCapture("first\nsecond\n   \n\n")).toBe("first\nsecond");
    expect(trimTmuxCapture("prompt $ ")).toBe("prompt $");
    expect(trimTmuxCapture("\n \t\n")).toBe("");
  });

  it("joins soft-wrapped shell history without joining alternate-screen TUI rows", () => {
    expect(buildTmuxCapturePaneArgs("shell", 5000, true)).toEqual([
      "capture-pane", "-p", "-J", "-t", "shell", "-S", "-5000"
    ]);
    expect(buildTmuxCapturePaneArgs("harness", 5000, false)).toEqual([
      "capture-pane", "-p", "-t", "harness", "-S", "-5000"
    ]);
  });

  it("opens the OpenCode database read-only", () => {
    expect(buildOpenCodeSqliteArgs("/tmp/missing.db", "SELECT 1")).toEqual([
      "-readonly", "-json", "/tmp/missing.db", "SELECT 1"
    ]);
    expect(buildOpenCodeSqliteArgs("/tmp/missing.db", "SELECT 1", false)).toEqual([
      "-readonly", "/tmp/missing.db", "SELECT 1"
    ]);
  });

  it("recognizes wide OpenCode alternate-screen panes", () => {
    expect(parseTmuxPaneMetadata("opencode\t172\t48\t1\n")).toEqual({
      currentCommand: "opencode",
      width: 172,
      height: 48,
      alternateScreen: true
    });
    expect(isOpenCodeFullTuiPane({ currentCommand: "opencode", width: 172, height: 48, alternateScreen: true })).toBe(true);
    expect(isOpenCodeFullTuiPane({ currentCommand: "/usr/local/bin/opencode.exe", width: 172, height: 48, alternateScreen: true })).toBe(true);
    expect(isOpenCodeFullTuiPane({ currentCommand: "opencode", width: 120, height: 48, alternateScreen: true })).toBe(false);
    expect(isOpenCodeFullTuiPane({ currentCommand: "zsh", width: 172, height: 48, alternateScreen: true })).toBe(false);
    expect(() => parseTmuxPaneMetadata("opencode\twide\t48\t1")).toThrow("Invalid tmux pane metadata");
    expect(parseTmuxPaneMetadata("opencode\t172\t48\t1\t458362\t/workspace/app\tOC | Active task\n")).toEqual({
      currentCommand: "opencode",
      width: 172,
      height: 48,
      alternateScreen: true,
      panePid: 458362,
      currentPath: "/workspace/app",
      paneTitle: "OC | Active task"
    });
  });

  it("splits display columns without breaking wide glyphs", () => {
    expect(splitDisplayLineAtColumn("ab界cd", 4)).toEqual(["ab界", "cd"]);
    expect(splitDisplayLineAtColumn("terminal", 4)).toEqual(["term", "inal"]);
  });

  it("treats escape sequences as zero-width and keeps the sidebar plain", () => {
    const red = "\u001b[31m";
    const blue = "\u001b[38;2;0;0;255m";
    const reset = "\u001b[0m";
    expect(splitDisplayLineAtColumn(`${red}term${reset}${blue}inal${reset}`, 4)).toEqual([`${red}term${reset}${blue}${reset}`, "inal"]);
    expect(splitDisplayLineAtColumn(`ab${red}界cd`, 4)).toEqual([`ab${red}界`, "cd"]);
  });

  it("keeps colours in the OpenCode terminal column when the capture has escapes", () => {
    const mainWidth = 88;
    const row = (main: string, sidebar: string) => `\u001b[32m${main}\u001b[0m${" ".repeat(mainWidth - main.length)}\u001b[1m${sidebar}\u001b[22m`;
    const capture = [
      row("Reply", "Session title"),
      row("OK", "Context"),
      row("", "• OpenCode 1.18.3")
    ].join("\n");
    const view = splitOpenCodeTuiCapture(capture, 130);
    expect(view?.sidebar).toEqual({ kind: "opencode", output: "Session title\nContext\n• OpenCode 1.18.3" });
    expect(view?.output.split("\n")[0]).toMatch(/^\u001b\[32mReply\u001b\[0m\s*\u001b\[1m\u001b\[22m$/);
  });

  it("extracts OpenCode's fixed-width sidebar from a full TUI capture", () => {
    const mainWidth = 88;
    const row = (main: string, sidebar: string) => `${main.padEnd(mainWidth)}${sidebar}`;
    const capture = [
      row("Reply with exactly OK.", "Session title"),
      row("OK", "Context"),
      row("", "25,467 tokens"),
      row("Build auto", "MCP"),
      row("", "• OpenCode 1.18.3")
    ].join("\n");

    expect(splitOpenCodeTuiCapture(capture, 130)).toEqual({
      output: "Reply with exactly OK.\nOK\n\nBuild auto",
      sidebar: {
        kind: "opencode",
        output: "Session title\nContext\n25,467 tokens\nMCP\n• OpenCode 1.18.3"
      }
    });
    expect(splitOpenCodeTuiCapture(row("terminal only", "not a sidebar"), 130)).toBeNull();
  });

  it("splits only visible OpenCode rows and preserves historical scrollback", () => {
    const mainWidth = 88;
    const row = (main: string, sidebar: string) => `${main.padEnd(mainWidth)}${sidebar}`;
    const history = "historical output that must remain intact even when it is wider than the current main pane";
    const capture = [
      history,
      row("current reply", "Session title"),
      row("", "Context"),
      row("Build auto", "25,467 tokens"),
      row("", "• OpenCode 1.18.3")
    ].join("\n");

    expect(splitOpenCodeTuiCapture(capture, 130, 4)).toEqual({
      output: `${history}\ncurrent reply\n\nBuild auto`,
      sidebar: {
        kind: "opencode",
        output: "Session title\nContext\n25,467 tokens\n• OpenCode 1.18.3"
      }
    });
  });
});

function paneLine(fields: {
  session: string;
  pane: string;
  window?: string;
  windowIndex: number;
  paneIndex: number;
  windowActive?: boolean;
  paneActive?: boolean;
  attached?: number;
  command?: string;
  path?: string;
  title?: string;
  windowName?: string;
  windowPanes?: number;
  hideOrigin?: string;
  hideUntil?: string;
}): string {
  return [
    fields.session,
    fields.pane,
    fields.window ?? `@${fields.windowIndex}`,
    String(fields.windowIndex),
    String(fields.paneIndex),
    fields.windowActive ? "1" : "0",
    fields.paneActive ? "1" : "0",
    "4",
    "1778630000",
    String(fields.attached ?? 0),
    "1778630100",
    fields.command ?? "zsh",
    "4242",
    fields.path ?? "/home/me/work/app",
    String(fields.windowPanes ?? 1),
    "mini.local",
    fields.hideOrigin ?? "",
    fields.hideUntil ?? "",
    fields.windowName ?? "zsh",
    fields.title ?? "mini.local"
  ].join("\t");
}

describe("tmux pane listing", () => {
  it("parses window names and pane titles with spaces, pipes, tabs, and unicode", () => {
    const panes = parseTmuxPanes([
      paneLine({ session: "main", pane: "%39", windowIndex: 2, paneIndex: 0, windowName: "\u2733 Research notes thread", title: "\u2733 Research notes thread" }),
      paneLine({ session: "main", pane: "%49", windowIndex: 4, paneIndex: 0, windowName: "\u03c0 - personal", title: "pi\tagent" }),
      paneLine({ session: "gp", pane: "%27", windowIndex: 1, paneIndex: 0, windowName: "[ ! ] Action Required | Review build output | .gp" }),
      paneLine({ session: "gp", pane: "%1", windowIndex: 0, paneIndex: 0, windowName: "gpmon", windowPanes: 2, title: "\u2733 Tmux" }),
      paneLine({ session: "gp", pane: "%7", windowIndex: 0, paneIndex: 1, windowName: "gpmon", windowPanes: 2, title: "mini" }),
      paneLine({ session: "main", pane: "%31", windowIndex: 0, paneIndex: 1, windowName: "brief", windowPanes: 2, title: "" }),
      paneLine({ session: "main", pane: "%44", windowIndex: 3, paneIndex: 0, windowName: "claude", title: "\u2733 Draft network spec" }),
      paneLine({ session: "main", pane: "%50", windowIndex: 5, paneIndex: 0, windowName: "notes", title: "mini.local" })
    ].join("\n"), "/home/me");
    const byName = new Map(panes.map((pane) => [pane.name, pane]));

    expect(byName.get("%39")).toMatchObject({
      windowName: "\u2733 Research notes thread",
      displayName: "Research notes thread",
      label: "main:2.0 \u00b7 zsh \u00b7 ~/work/app"
    });
    expect(byName.get("%49")).toMatchObject({ windowName: "\u03c0 - personal", displayName: "pi\tagent", paneTitle: "pi\tagent" });
    expect(byName.get("%27")?.displayName).toBe("[ ! ] Action Required | Review build output | .gp");
    expect(byName.get("%1")?.displayName).toBe("Tmux");
    expect(byName.get("%7")?.displayName).toBe("gpmon \u00b7 pane 1");
    expect(byName.get("%31")?.displayName).toBe("brief \u00b7 pane 1");
    expect(byName.get("%44")?.displayName).toBe("Draft network spec");
    expect(byName.get("%50")?.displayName).toBe("notes");
  });

  it("names panes by pane title, then window name, then pane number, then location", () => {
    const base = { paneIndex: 1, host: "mini.local", fallback: "main:0.1" };
    expect(buildTmuxPaneDisplayName({ ...base, windowName: "brief", paneTitle: "brief notes", windowPanes: 1 })).toBe("brief notes");
    expect(buildTmuxPaneDisplayName({ ...base, windowName: "brief", paneTitle: "brief notes", windowPanes: 2 })).toBe("brief notes");
    expect(buildTmuxPaneDisplayName({ ...base, windowName: "brief", paneTitle: "✳ La chat", windowPanes: 1 })).toBe("La chat");
    expect(buildTmuxPaneDisplayName({ ...base, windowName: "brief", paneTitle: "⠂ Atw", windowPanes: 1 })).toBe("Atw");
    expect(buildTmuxPaneDisplayName({ ...base, windowName: "brief", paneTitle: "π - notes - work", windowPanes: 1 })).toBe("π - notes - work");
    expect(buildTmuxPaneDisplayName({ ...base, windowName: "brief", paneTitle: "mini", windowPanes: 1 })).toBe("brief");
    expect(buildTmuxPaneDisplayName({ ...base, windowName: "brief", paneTitle: "mini.local", windowPanes: 2 })).toBe("brief \u00b7 pane 1");
    expect(buildTmuxPaneDisplayName({ ...base, windowName: "", paneTitle: "", windowPanes: 1 })).toBe("main:0.1");
    expect(buildTmuxPaneDisplayName({ ...base, windowName: "", paneTitle: "mini.local", windowPanes: 2 })).toBe("main:0.1");
  });

  it("lists every pane across sessions with session-level metadata", () => {
    expect(buildTmuxListPanesArgs()).toEqual(["list-panes", "-a", "-F", TMUX_LIST_PANES_FORMAT]);
    expect(TMUX_LIST_PANES_FORMAT.split("\t").slice(0, 2)).toEqual(["#{session_name}", "#{pane_id}"]);

    const panes = parseTmuxPanes([
      paneLine({ session: "main", pane: "%32", windowIndex: 0, paneIndex: 0, paneActive: true, attached: 1, command: "2.1.288" }),
      paneLine({ session: "main", pane: "%31", windowIndex: 0, paneIndex: 1, attached: 1 }),
      paneLine({ session: "main", pane: "%20", windowIndex: 1, paneIndex: 0, windowActive: true, paneActive: true, attached: 1, command: "node", path: "/home/me" })
    ].join("\n"), "/home/me");

    expect(panes.map((pane) => pane.name)).toEqual(["%32", "%31", "%20"]);
    expect(panes[0]).toMatchObject({
      name: "%32",
      session: "main",
      paneId: "%32",
      windowId: "@0",
      windowIndex: 0,
      paneIndex: 0,
      windowActive: false,
      paneActive: true,
      label: "main:0.0 \u00b7 claude \u00b7 ~/work/app",
      windows: 4,
      attached: true,
      clientCount: 1,
      panePid: 4242,
      currentPath: "/home/me/work/app",
      currentCommand: "2.1.288",
      windowName: "zsh",
      displayName: "zsh",
      paneTitle: "mini.local"
    });
    expect(panes[2].label).toBe("main:1.0 \u00b7 node \u00b7 ~");
  });

  it("sorts by session, window, and pane and skips malformed rows", () => {
    const panes = parseTmuxPanes([
      paneLine({ session: "main", pane: "%4", windowIndex: 2, paneIndex: 0 }),
      "garbage",
      paneLine({ session: "gp", pane: "%7", windowIndex: 0, paneIndex: 1 }),
      paneLine({ session: "main", pane: "%3", windowIndex: 1, paneIndex: 1 }),
      paneLine({ session: "gp", pane: "%1", windowIndex: 0, paneIndex: 0 }),
      paneLine({ session: "main", pane: "not-a-pane", windowIndex: 0, paneIndex: 0 })
    ].join("\n"));

    expect(panes.map((pane) => `${pane.session}:${pane.windowIndex}.${pane.paneIndex}`)).toEqual([
      "gp:0.0",
      "gp:0.1",
      "main:1.1",
      "main:2.0"
    ]);
  });

  it("hides atw raw sessions and lists grouped panes once", () => {
    const panes = parseTmuxPanes([
      paneLine({ session: "atw-raw-1a2b", pane: "%9", windowIndex: 0, paneIndex: 0, attached: 1 }),
      paneLine({ session: "main", pane: "%9", windowIndex: 0, paneIndex: 0 }),
      paneLine({ session: "main-mirror", pane: "%9", windowIndex: 0, paneIndex: 0 }),
      paneLine({ session: "dk--box--atw-raw-ff00", pane: "dk--box--%2", windowIndex: 0, paneIndex: 0 })
    ].join("\n"));

    expect(panes.map((pane) => [pane.session, pane.name])).toEqual([["main", "%9"]]);
  });

  it("marks panes of windows tmux-hide-window snoozed into _hidden with their wake time", () => {
    const format = TMUX_LIST_PANES_FORMAT.split("\t");
    expect(format.slice(-4)).toEqual(["#{@hide_origin}", "#{@hide_until}", "#{window_name}", "#{pane_title}"]);

    const panes = parseTmuxPanes([
      paneLine({ session: "_hidden", pane: "%8", windowIndex: 1, paneIndex: 0, hideOrigin: "$2", hideUntil: "1792003790" }),
      paneLine({ session: "_hidden", pane: "%9", windowIndex: 2, paneIndex: 0, hideOrigin: "$2" }),
      paneLine({ session: "_hidden", pane: "%10", windowIndex: 3, paneIndex: 0, hideOrigin: "$2", hideUntil: "soon" }),
      paneLine({ session: "_hidden", pane: "%11", windowIndex: 4, paneIndex: 0, hideUntil: "1792003790" }),
      paneLine({ session: "main", pane: "%12", windowIndex: 0, paneIndex: 0, hideOrigin: "$2", hideUntil: "1792003790" }),
      paneLine({ session: "main", pane: "%13", windowIndex: 1, paneIndex: 0, windowName: "plain" })
    ].join("\n"));
    const snoozed = Object.fromEntries(panes.map((pane) => [pane.name, pane.snoozedUntilMs]));

    expect(snoozed).toEqual({
      "%8": 1792003790000,
      // Hidden without a deadline, junk deadline, no home session, and peeked back in: not snoozed.
      "%9": undefined,
      "%10": undefined,
      "%11": undefined,
      "%12": undefined,
      "%13": undefined
    });
    expect(panes.find((pane) => pane.name === "%13")?.windowName).toBe("plain");
    expect(parseTmuxWindowSnooze("_hidden", "$2", "0")).toBeUndefined();
    expect(parseTmuxWindowSnooze("_hidden", "$2", "-5")).toBeUndefined();
  });

  it("keeps shim-prefixed container panes routable", () => {
    const [pane] = parseTmuxPanes(paneLine({ session: "dk--box--work", pane: "dk--box--%5", windowIndex: 1, paneIndex: 2 }));

    expect(pane).toMatchObject({ name: "dk--box--%5", session: "dk--box--work", paneId: "%5" });
    expect(splitTmuxPaneTarget("dk--box--%5")).toEqual({ routingPrefix: "dk--box--", paneId: "%5" });
    expect(splitTmuxPaneTarget("%12")).toEqual({ routingPrefix: "", paneId: "%12" });
    expect(splitTmuxPaneTarget("main")).toBeNull();
  });

  it("builds readable pane labels", () => {
    expect(buildTmuxPaneLabel({ session: "main", windowIndex: 1, paneIndex: 0, currentCommand: "codex", currentPath: "/srv/a/b/c/d" }, "/home/me"))
      .toBe("main:1.0 \u00b7 codex \u00b7 /\u2026/c/d");
    expect(buildTmuxPaneLabel({ session: "gp", windowIndex: 0, paneIndex: 1 })).toBe("gp:0.1");
    expect(displayTmuxPaneCommand("2.1.288")).toBe("claude");
    expect(displayTmuxPaneCommand("pi")).toBe("pi");
    expect(shortenTmuxPanePath("/home/me/work/playground/x/y", "/home/me")).toBe("~/\u2026/x/y");
    expect(shortenTmuxPanePath("/home/me/work/playground", "/home/me/")).toBe("~/work/playground");
    expect(shortenTmuxPanePath("/home/meadow/x", "/home/me")).toBe("/home/meadow/x");
    expect(shortenTmuxPanePath(undefined, "/home/me")).toBe("");
  });

  it("resolves pane targets and legacy session names", () => {
    const panes = parseTmuxPanes([
      paneLine({ session: "main", pane: "%1", windowIndex: 0, paneIndex: 0, paneActive: true }),
      paneLine({ session: "main", pane: "%2", windowIndex: 1, paneIndex: 0, windowActive: true }),
      paneLine({ session: "main", pane: "%3", windowIndex: 1, paneIndex: 1, windowActive: true, paneActive: true })
    ].join("\n"));

    expect(resolveTmuxPaneEntry(panes, "%2")?.name).toBe("%2");
    expect(resolveTmuxPaneEntry(panes, "main")?.name).toBe("%3");
    expect(resolveTmuxPaneEntry(panes, "missing")).toBeNull();
    expect(resolveTmuxSessionName(panes, "%2")).toBe("main");
    expect(resolveTmuxSessionName(panes, "other")).toBe("other");
  });

  it("keeps escape sequences only when colour capture is asked for", () => {
    expect(buildTmuxCapturePaneArgs("%38", 100, true, true)).toEqual(["capture-pane", "-p", "-e", "-J", "-t", "%38", "-S", "-100"]);
    expect(buildTmuxCapturePaneArgs("%38", 100, true)).not.toContain("-e");
    expect(trimTmuxAnsiCapture("\u001b[31mred\u001b[39m\n\u001b[0m  \n\u001b[49m\n")).toBe("\u001b[31mred");
    expect(trimTmuxAnsiCapture("plain\n\n")).toBe("plain");
  });

  it("targets the specific pane for capture, send, submit, and interrupt", () => {
    expect(buildTmuxCapturePaneArgs("%38", 100)).toEqual(["capture-pane", "-p", "-t", "%38", "-S", "-100"]);
    expect(buildTmuxSubmitKeysArgs("%38")).toEqual(["send-keys", "-t", "%38", "Enter"]);
    expect(buildTmuxInterruptKeysArgs("%38", "ctrl-c")).toEqual(["send-keys", "-t", "%38", "C-c"]);
    expect(buildTmuxPaneInModeArgs("dk--box--%5")).toEqual(["display-message", "-p", "-t", "dk--box--%5", "#{pane_in_mode}"]);
  });

  it("reads session and window viewer counts for a pane", () => {
    expect(buildTmuxViewerCountArgs("%38")).toEqual([
      "display-message",
      "-p",
      "-t",
      "%38",
      "#{?session_grouped,#{session_group_attached},#{session_attached}} #{window_active_clients}"
    ]);
    expect(parseTmuxViewerCounts("2 1\n")).toEqual({ sessionClients: 2, windowClients: 1 });
    expect(parseTmuxViewerCounts("")).toEqual({ sessionClients: 0, windowClients: 0 });
  });
});

const tmuxAvailable = spawnSync("tmux", ["-V"]).status === 0;

describe.skipIf(!tmuxAvailable)("tmux pane targeting against a real tmux server", () => {
  const savedTmuxTmpdir = process.env.TMUX_TMPDIR;
  const savedTmux = process.env.TMUX;
  let socketDir = "";
  let socketPath = "";
  // Every direct tmux call names the private socket, so a leaked TMUX can never aim one at the live server.
  const testTmux = (args: string[]) => execFileAsync("tmux", ["-S", socketPath, ...args]);

  beforeAll(async () => {
    // Private socket dir so the code under test never touches the developer's tmux server.
    socketDir = await realpath(await mkdtemp(path.join(tmpdir(), "atw-tmux-")));
    socketPath = path.join(socketDir, `tmux-${process.getuid?.() ?? 0}`, "default");
    await mkdir(path.dirname(socketPath), { recursive: true, mode: 0o700 });
    process.env.TMUX_TMPDIR = socketDir;
    delete process.env.TMUX;
    await testTmux(["new-session", "-d", "-s", "atwtest", "-x", "120", "-y", "40", "sh"]);
    const { stdout } = await execFileAsync("tmux", ["display-message", "-p", "-t", "atwtest", "#{socket_path}"]);
    expect(stdout.trim()).toBe(socketPath);
    await testTmux(["split-window", "-t", "atwtest", "sh"]);
    await testTmux(["new-session", "-d", "-t", "atwtest", "-s", "atw-raw-test"]);
  });

  afterAll(async () => {
    if (socketPath) await testTmux(["kill-server"]).catch(() => undefined);
    if (savedTmuxTmpdir === undefined) {
      delete process.env.TMUX_TMPDIR;
    } else {
      process.env.TMUX_TMPDIR = savedTmuxTmpdir;
    }
    if (savedTmux !== undefined) {
      process.env.TMUX = savedTmux;
    }
    await rm(socketDir, { recursive: true, force: true });
  });

  it("lists both panes once and sends only to the non-active pane", async () => {
    const panes = (await listTmuxSessions()).filter((pane) => pane.session === "atwtest");
    expect(panes.map((pane) => [pane.windowIndex, pane.paneIndex])).toEqual([[0, 0], [0, 1]]);
    expect((await listTmuxSessions()).some((pane) => pane.session === "atw-raw-test")).toBe(false);

    const inactive = panes.find((pane) => !pane.paneActive);
    const active = panes.find((pane) => pane.paneActive);
    expect(inactive?.name).toMatch(/^%\d+$/);
    expect(active).toBeDefined();

    await sendTmuxText(inactive!.name, "echo PANE_TARGET_MARK", true, "enter");
    let inactiveOutput = "";
    for (let attempt = 0; attempt < 30 && !/^PANE_TARGET_MARK$/m.test(inactiveOutput); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      inactiveOutput = await captureTmuxPane(inactive!.name, 50);
    }

    expect(inactiveOutput).toMatch(/^PANE_TARGET_MARK$/m);
    expect(await captureTmuxPane(active!.name, 50)).not.toContain("PANE_TARGET_MARK");
  });

  it("sends named control and meta keys, including an escaped M-;", async () => {
    const pane = (await listTmuxSessions()).find((entry) => entry.session === "atwtest" && !entry.paneActive);
    expect(pane).toBeDefined();
    await sendTmuxText(pane!.name, "clear; cat -v", true, "enter");
    await new Promise((resolve) => setTimeout(resolve, 200));
    for (const key of ["M-x", "M-;", "C-b", "Enter", "C-d"]) {
      await sendTmuxKey(pane!.name, key);
    }
    let output = "";
    for (let attempt = 0; attempt < 30 && !/\^\[x\^\[;\^B/.test(output); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      output = await captureTmuxPane(pane!.name, 50);
    }
    expect(output).toMatch(/\^\[x\^\[;\^B/);
    await expect(sendTmuxKey(pane!.name, "kill-server")).rejects.toThrow(/Unsupported tmux key/);
  });

  it("closes one pane and leaves its sibling running", async () => {
    await testTmux(["new-session", "-d", "-s", "atwclose", "sh"]);
    await testTmux(["split-window", "-t", "atwclose", "sh"]);
    const before = (await listTmuxSessions()).filter((entry) => entry.session === "atwclose");
    expect(before).toHaveLength(2);
    const victim = resolveClosableTmuxPane(await listTmuxSessions(), before[1]!.name);
    await closeTmuxPane(victim.name);
    const after = (await listTmuxSessions()).filter((entry) => entry.session === "atwclose");
    expect(after.map((entry) => entry.name)).toEqual([before[0]!.name]);
  });

  it("captures ANSI colours, including 256-colour and truecolor, when asked", async () => {
    const pane = (await listTmuxSessions()).find((entry) => entry.session === "atwtest" && entry.paneActive);
    expect(pane).toBeDefined();
    await sendTmuxText(pane!.name, "printf '\\033[31mRED\\033[0m \\033[38;5;208mORANGE\\033[0m \\033[38;2;10;200;30mTRUE\\033[0m\\n'", true, "enter");
    let colored = "";
    for (let attempt = 0; attempt < 30 && !/^\S*RED/m.test(colored.replace(/\u001b\[[0-9;:]*m/g, "")); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      colored = (await captureTmuxPaneView(pane!.name, 50, undefined, { ansi: true })).output;
    }
    expect(colored).toContain("\u001b[31mRED");
    expect(colored).toContain("\u001b[38;5;208mORANGE");
    expect(colored).toContain("\u001b[38;2;10;200;30mTRUE");
    const plain = (await captureTmuxPaneView(pane!.name, 50)).output;
    expect(plain).toMatch(/^RED ORANGE TRUE$/m);
    expect(plain).not.toContain("\u001b");
  });
});
