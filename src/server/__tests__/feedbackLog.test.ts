import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FeedbackLog } from "../feedbackLog.js";

const AT_MS = Date.parse("2026-10-30T22:04:47.000Z");
const SUBMISSION = {
  target: "%9",
  text: "Feedback from the Agent Tmux web UI: hi (view TTY) Screenshot: ~/.agent-tmux/attachments/2026-10-30/s.png",
  message: "hi",
  context: { view: "TTY", pane: "" },
  screenshot: "~/.agent-tmux/attachments/2026-10-30/s.png"
};

async function readLines(filePath: string): Promise<Array<Record<string, unknown>>> {
  return (await readFile(filePath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("feedback log", () => {
  let dir = "";
  let filePath = "";
  let ids = 0;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "atw-feedback-log-"));
    filePath = path.join(dir, "atw", "feedback.jsonl");
    ids = 0;
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function log(target = filePath): FeedbackLog {
    return new FeedbackLog({ filePath: target, now: () => AT_MS, newId: () => `f${++ids}` });
  }

  it("appends the submission before returning, then one outcome line per entry", async () => {
    const feedback = log();
    const first = await feedback.record(SUBMISSION);
    expect(await readLines(filePath)).toEqual([{ id: "f1", at: "2026-10-30T22:04:47.000Z", ...SUBMISSION }]);
    const second = await feedback.record({ ...SUBMISSION, message: "two" });
    await feedback.outcome(second, { outcome: "queued" });
    await feedback.outcome(first, { outcome: "retried" });
    expect((await readLines(filePath)).slice(2)).toEqual([
      { id: "f2", at: "2026-10-30T22:04:47.000Z", outcome: "queued" },
      { id: "f1", at: "2026-10-30T22:04:47.000Z", outcome: "retried" }
    ]);
  });

  it("logs an undelivered outcome with its reason and text to the server log too", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const feedback = log();
      const entry = await feedback.record(SUBMISSION);
      await feedback.outcome(entry, { outcome: "undelivered", reason: "not seen landing after retyping" });
      expect((await readLines(filePath))[1]).toEqual({ id: "f1", at: "2026-10-30T22:04:47.000Z", outcome: "undelivered", reason: "not seen landing after retyping" });
      expect(error).toHaveBeenCalledWith(expect.stringMatching(/f1 to %9 undelivered \(not seen landing after retyping\): Feedback from the Agent Tmux web UI: hi/));
    } finally {
      error.mockRestore();
    }
  });

  it("never throws when the file cannot be written, and puts the line in the server log instead", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const blocker = path.join(dir, "not-a-dir");
      await writeFile(blocker, "");
      const feedback = log(path.join(blocker, "feedback.jsonl"));
      const entry = await feedback.record(SUBMISSION);
      expect(entry.id).toBe("f1");
      expect(error).toHaveBeenCalledWith(expect.stringContaining("\"message\":\"hi\""), expect.anything());
      await feedback.outcome(entry, { outcome: "delivered" });
      await feedback.flush();
    } finally {
      error.mockRestore();
    }
  });
});
