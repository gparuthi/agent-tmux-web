import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ClaudePromptTimes,
  claudeProjectDirName,
  isOwnerTypedPrompt,
  isLiveClaudePane,
  lastAssistantText,
  lastHumanPromptAtMs,
  parseClaudeSessionFile,
  parseProcessParents,
  summarizeClaudeText
} from "../claudePrompts.js";

const assistantLine = (content: unknown, extra: Record<string, unknown> = {}) => JSON.stringify({
  type: "assistant",
  timestamp: "2026-10-04T17:40:00.000Z",
  isSidechain: false,
  message: { role: "assistant", content },
  ...extra
});

const userLine = (timestamp: string, origin: string | null, content: unknown = "hi") => JSON.stringify({
  type: "user",
  timestamp,
  ...(origin ? { origin: { kind: origin } } : {}),
  message: { role: "user", content }
});

describe("Claude prompt source", () => {
  it("reads the pane and session id from a Claude session file", () => {
    expect(parseClaudeSessionFile(JSON.stringify({ pid: 13222, sessionId: "abc", cwd: "/Users/me/.gp", tmux: "fleet:@11.%12" })))
      .toEqual({ pid: 13222, sessionId: "abc", cwd: "/Users/me/.gp", paneId: "%12" });
    expect(parseClaudeSessionFile(JSON.stringify({ pid: 1, sessionId: "abc", cwd: "/x" }))).toBeNull();
    expect(parseClaudeSessionFile("{")).toBeNull();
  });

  it("names project directories like Claude Code", () => {
    expect(claudeProjectDirName("/Users/gauravparuthi/.gp")).toBe("-Users-gauravparuthi--gp");
    expect(claudeProjectDirName("/Users/me/work/agent-tmux-web")).toBe("-Users-me-work-agent-tmux-web");
  });

  it("finds the newest owner-typed prompt and ignores peers, tool results and cut lines", () => {
    const tail = [
      "ated\",\"origin\":{\"kind\":\"human\"}}",
      userLine("2026-10-04T17:30:00.000Z", "human"),
      userLine("2026-10-04T17:35:00.000Z", "peer"),
      userLine("2026-10-04T17:36:00.000Z", null, [{ type: "tool_result", content: "human" }]),
      JSON.stringify({ type: "assistant", timestamp: "2026-10-04T17:37:00.000Z", origin: { kind: "human" } }),
      ""
    ].join("\n");
    expect(lastHumanPromptAtMs(tail)).toBe(Date.parse("2026-10-04T17:30:00.000Z"));
    expect(lastHumanPromptAtMs(userLine("2026-10-04T17:35:00.000Z", "task-notification"))).toBeUndefined();
  });

  it("counts only prompts the owner submitted, shaped like Claude Code's real records", () => {
    // A real typed prompt: string content, human origin, promptSource typed.
    const typed = { type: "user", timestamp: "2026-10-29T22:41:21.438Z", origin: { kind: "human" }, promptSource: "typed", turnOrigin: "human", isSidechain: false, userType: "external", message: { role: "user", content: "take 2 lines on desktop" } };
    expect(isOwnerTypedPrompt(typed)).toBe(true);
    expect(isOwnerTypedPrompt({ ...typed, promptSource: "queued" })).toBe(true);
    expect(isOwnerTypedPrompt({ ...typed, message: { role: "user", content: [{ type: "text", text: "with an image" }, { type: "image" }] } })).toBe(true);
    expect(isOwnerTypedPrompt({ ...typed, isMeta: true })).toBe(false);
    expect(isOwnerTypedPrompt({ ...typed, isSidechain: true })).toBe(false);
    expect(isOwnerTypedPrompt({ ...typed, isCompactSummary: true })).toBe(false);
    expect(isOwnerTypedPrompt({ ...typed, isVisibleInTranscriptOnly: true })).toBe(false);
    expect(isOwnerTypedPrompt({ ...typed, origin: { kind: "task-notification" } })).toBe(false);
    expect(isOwnerTypedPrompt({ ...typed, origin: undefined })).toBe(false);
    expect(isOwnerTypedPrompt({ ...typed, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] } })).toBe(false);
    expect(isOwnerTypedPrompt({ ...typed, message: { role: "user", content: "<local-command-stdout>Set model</local-command-stdout>" } })).toBe(false);
    expect(isOwnerTypedPrompt({ ...typed, message: { role: "user", content: "<system-reminder>hook said</system-reminder>" } })).toBe(false);
    expect(isOwnerTypedPrompt({ ...typed, message: { role: "user", content: [{ type: "text", text: "<bash-stdout>ok</bash-stdout>" }] } })).toBe(false);
    expect(isOwnerTypedPrompt({ ...typed, message: { role: "user", content: "  " } })).toBe(false);
  });

  it("keeps the agent's newest main-thread text, skipping thinking, tool calls, subagents and cut lines", () => {
    const tail = [
      "t\",\"text\":\"cut\"}]}}",
      assistantLine([{ type: "text", text: "Earlier reply." }]),
      assistantLine([{ type: "thinking", thinking: "hmm" }, { type: "text", text: "\n## Shipped it\nmore detail" }]),
      userLine("2026-10-04T17:41:00.000Z", "human"),
      assistantLine([{ type: "thinking", thinking: "text" }]),
      assistantLine([{ type: "tool_use", name: "Bash", input: { command: "text" } }]),
      assistantLine([{ type: "text", text: "From a subagent" }], { isSidechain: true }),
      ""
    ].join("\n");
    expect(lastAssistantText(tail)).toBe("Shipped it");
    expect(lastAssistantText(userLine("2026-10-04T17:41:00.000Z", "human"))).toBeUndefined();
    expect(lastAssistantText(assistantLine([{ type: "text", text: "  \n " }]))).toBeUndefined();
  });

  it("summarizes text to its first line, without markdown bullets, capped with an ellipsis", () => {
    expect(summarizeClaudeText("- **Done:** pushed   `abc123` to main\nsecond")).toBe("Done: pushed abc123 to main");
    expect(summarizeClaudeText("\n\n> quoted")).toBe("quoted");
    expect(summarizeClaudeText("x".repeat(200), 10)).toBe(`${"x".repeat(9)}…`);
    expect(summarizeClaudeText("")).toBe("");
  });

  it("trusts a session file only while its process lives in that pane", () => {
    const parents = parseProcessParents("  13222  1559\n  1559 1\n  900 13222\n");
    const session = { pid: 13222, sessionId: "abc", cwd: "/x", paneId: "%12" };
    expect(isLiveClaudePane(session, { paneId: "%12", panePid: 13222 }, parents)).toBe(true);
    expect(isLiveClaudePane(session, { paneId: "%12", panePid: 1559 }, parents)).toBe(true);
    expect(isLiveClaudePane(session, { paneId: "%12", panePid: 4444 }, parents)).toBe(false);
    expect(isLiveClaudePane(session, undefined, parents)).toBe(false);
    expect(isLiveClaudePane({ ...session, pid: 31337 }, { paneId: "%12", panePid: 31337 }, parents)).toBe(false);
  });
});

describe("ClaudePromptTimes", () => {
  let dir = "";
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "atw-claude-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("maps live panes to their last human prompt and skips stale session files", async () => {
    const cwd = "/Users/me/work/app";
    await mkdir(path.join(dir, "sessions"), { recursive: true });
    await mkdir(path.join(dir, "projects", claudeProjectDirName(cwd)), { recursive: true });
    await writeFile(path.join(dir, "sessions", `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: "live", cwd, tmux: "main:@1.%7" }));
    await writeFile(path.join(dir, "sessions", "999999.json"), JSON.stringify({ pid: 999999, sessionId: "dead", cwd, tmux: "main:@1.%8" }));
    await writeFile(path.join(dir, "projects", claudeProjectDirName(cwd), "live.jsonl"), `${userLine("2026-10-04T17:30:00.000Z", "human")}\n${assistantLine([{ type: "text", text: "All green." }])}\n`);
    await writeFile(path.join(dir, "projects", claudeProjectDirName(cwd), "dead.jsonl"), `${userLine("2026-10-04T17:31:00.000Z", "human")}\n`);

    const times = new ClaudePromptTimes(dir);
    const panes = [{ paneId: "%7", panePid: process.pid }, { paneId: "%8", panePid: 999999 }];
    expect(times.get(panes).size).toBe(0);
    await times.refresh(panes);
    expect([...times.get(panes)]).toEqual([["%7", Date.parse("2026-10-04T17:30:00.000Z")]]);
    expect([...times.said()]).toEqual([["%7", "All green."]]);
    // The dead session's pane is not a live Claude pane.
    expect([...times.livePanes()]).toEqual(["%7"]);
  });

  it("reads further back once when a tool-heavy tail holds no prompt, as after a restart", async () => {
    // Regression: gpmon-fix lost its prompt time after a restart because 512 KiB of tool calls followed it.
    const cwd = "/Users/me/.gp";
    await mkdir(path.join(dir, "sessions"), { recursive: true });
    await mkdir(path.join(dir, "projects", claudeProjectDirName(cwd)), { recursive: true });
    await writeFile(path.join(dir, "sessions", `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: "busy", cwd, tmux: "gp:@4.%165" }));
    const toolCall = assistantLine([{ type: "tool_use", id: "t1", name: "Bash", input: { command: "x".repeat(2000) } }]);
    const lines = [userLine("2026-10-29T05:18:12.427Z", "human"), ...Array.from({ length: 400 }, () => toolCall), ""];
    await writeFile(path.join(dir, "projects", claudeProjectDirName(cwd), "busy.jsonl"), lines.join("\n"));

    const times = new ClaudePromptTimes(dir);
    const panes = [{ paneId: "%165", panePid: process.pid }];
    await times.refresh(panes);
    expect([...times.get(panes)]).toEqual([["%165", Date.parse("2026-10-29T05:18:12.427Z")]]);
  });

  it("returns nothing when there is no Claude config", async () => {
    const times = new ClaudePromptTimes(path.join(dir, "missing"));
    await times.refresh([{ paneId: "%1", panePid: process.pid }]);
    expect(times.get([]).size).toBe(0);
  });
});
