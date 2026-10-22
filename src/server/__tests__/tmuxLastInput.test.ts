import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  buildTmuxClientActivityArgs,
  latestTmuxInputAtMs,
  parseTmuxClientActivity,
  parseTmuxLastInputFile,
  pruneTmuxLastInput,
  storedTmuxInputAtMs,
  TmuxLastInputStore
} from "../tmuxLastInput.js";

describe("tmux client input activity", () => {
  it("asks list-clients for key activity and the viewed pane", () => {
    expect(buildTmuxClientActivityArgs()).toEqual(["list-clients", "-F", "#{client_activity}\t#{pane_id}\t#{session_name}"]);
  });

  it("keeps the latest keystroke per pane and skips atw raw clients", () => {
    const output = [
      "1791137840\t%10\tgp",
      "1791138742\t%5\tmain",
      "1791138000\t%5\tmain",
      "1791139999\t%5\tatw-raw-1a2b",
      "1791139999\t%7\tlab--atw-raw-ff00",
      "0\t%8\tmain",
      "junk\t%9\tmain",
      "1791138742\t\tmain",
      "1791138742\tmain:0.0\tmain",
      ""
    ].join("\n");

    expect([...parseTmuxClientActivity(output)]).toEqual([
      ["%10", 1791137840000],
      ["%5", 1791138742000]
    ]);
  });

  it("takes the newest of atw sends and terminal keystrokes", () => {
    expect(latestTmuxInputAtMs(5, 9)).toBe(9);
    expect(latestTmuxInputAtMs(undefined, 9)).toBe(9);
    expect(latestTmuxInputAtMs(undefined, undefined)).toBeUndefined();
    expect(latestTmuxInputAtMs(0)).toBeUndefined();
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
