import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  isTmuxSubmitInput,
  parseTmuxLastInputFile,
  pruneTmuxLastInput,
  storedTmuxInputAtMs,
  tmuxLastPromptAtMs,
  TmuxLastInputStore
} from "../tmuxLastInput.js";

describe("what counts as the owner's last prompt", () => {
  // Regression: gpmon-fix showed "1m ago" from a Ghostty client's client_activity (focus-in, mouse
  // wheel and window switches bump it) while its last typed prompt was 17h old.
  const created = Date.parse("2026-10-28T13:15:38Z");
  const transcriptPrompt = Date.parse("2026-10-29T05:18:12.427Z");

  it("takes a live Claude pane's time from its transcript only, never from atw's stored record", () => {
    const stored = Date.parse("2026-10-29T22:39:36Z");
    expect(tmuxLastPromptAtMs({ claudeLive: true, claudePromptAtMs: transcriptPrompt, storedAtMs: stored, createdAtMs: created })).toBe(transcriptPrompt);
    // No owner prompt in the transcript: show nothing rather than a keystroke time.
    expect(tmuxLastPromptAtMs({ claudeLive: true, storedAtMs: stored, createdAtMs: created })).toBeUndefined();
  });

  it("takes other panes' time from atw submits newer than the session", () => {
    expect(tmuxLastPromptAtMs({ claudeLive: false, storedAtMs: transcriptPrompt, createdAtMs: created })).toBe(transcriptPrompt);
    expect(tmuxLastPromptAtMs({ claudeLive: false, storedAtMs: created - 1, createdAtMs: created })).toBeUndefined();
    expect(tmuxLastPromptAtMs({ claudeLive: false, createdAtMs: created })).toBeUndefined();
  });

  it("counts raw-view Enter as a submit, but not focus reports, arrows, typing or a pasted newline", () => {
    expect(isTmuxSubmitInput("\r")).toBe(true);
    expect(isTmuxSubmitInput("ls -la\r")).toBe(true);
    expect(isTmuxSubmitInput("\x1b[200~line one\nline two\x1b[201~\r")).toBe(true);
    // Claude Code turns on focus reporting, so the browser's xterm sends these on every focus change.
    expect(isTmuxSubmitInput("\x1b[I")).toBe(false);
    expect(isTmuxSubmitInput("\x1b[O")).toBe(false);
    expect(isTmuxSubmitInput("\x1b[A")).toBe(false);
    expect(isTmuxSubmitInput("x")).toBe(false);
    expect(isTmuxSubmitInput("\x1b[200~line one\nline two\x1b[201~")).toBe(false);
  });
});

describe("tmux last input store", () => {
  let dir = "";
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "atw-last-input-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("parses the saved file defensively", () => {
    expect([...parseTmuxLastInputFile(JSON.stringify({ "%1": 10, "%2": "x", "": 4, "%3": -1 }))]).toEqual([["%1", 10]]);
    expect(parseTmuxLastInputFile("not json").size).toBe(0);
    expect(parseTmuxLastInputFile("[1,2]").size).toBe(0);
  });

  it("prunes to the newest entries", () => {
    const entries = new Map([["%1", 1], ["%2", 3], ["%3", 2]]);
    expect([...pruneTmuxLastInput(entries, 2).keys()]).toEqual(["%2", "%3"]);
  });

  it("records sends and survives a restart through an atomic file write", async () => {
    const filePath = path.join(dir, "nested", "last-input.json");
    let now = 1000;
    const store = new TmuxLastInputStore(filePath, () => now, 60_000);
    store.record("%4");
    now = 2000;
    store.record("%5");
    store.record("");
    expect(store.get("%4")).toBe(1000);
    await store.flush();

    expect(JSON.parse(await readFile(filePath, "utf8"))).toEqual({ "%5": 2000, "%4": 1000 });
    const restarted = new TmuxLastInputStore(filePath);
    await restarted.load();
    expect(restarted.get("%5")).toBe(2000);
    expect(restarted.get("%9")).toBeUndefined();
  });

  it("starts empty when the file is missing or corrupt", async () => {
    const missing = new TmuxLastInputStore(path.join(dir, "missing.json"));
    await missing.load();
    expect(missing.get("%1")).toBeUndefined();

    const corruptPath = path.join(dir, "corrupt.json");
    await writeFile(corruptPath, "{");
    const corrupt = new TmuxLastInputStore(corruptPath);
    await corrupt.load();
    expect(corrupt.get("%1")).toBeUndefined();
  });
});

describe("stored input of a reused pane id", () => {
  it("drops a record older than the pane, which belongs to a previous pane", () => {
    expect(storedTmuxInputAtMs(1000, 2000)).toBeUndefined();
  });

  it("keeps a record made at or after the pane was created", () => {
    expect(storedTmuxInputAtMs(2000, 2000)).toBe(2000);
    expect(storedTmuxInputAtMs(3000, 2000)).toBe(3000);
  });

  it("keeps the record when the pane creation time is unknown, and passes through no record", () => {
    expect(storedTmuxInputAtMs(1000, undefined)).toBe(1000);
    expect(storedTmuxInputAtMs(undefined, 2000)).toBeUndefined();
  });
});
