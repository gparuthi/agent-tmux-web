import { randomUUID } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const DEFAULT_FEEDBACK_LOG_FILE = path.join(os.homedir(), ".local", "state", "atw", "feedback.jsonl");

// delivered: typed (and, for a fresh session, seen landing); retried: landed after a resubmit or retype;
// queued: held by the send queue until the pane's turn ends; undelivered: not seen landing.
export type FeedbackOutcome = "delivered" | "queued" | "retried" | "undelivered";

export type FeedbackDeliveryResult = { outcome: FeedbackOutcome; reason?: string };

export type FeedbackSubmission = {
  target: string;
  text: string;
  message: string;
  context: Record<string, string | undefined>;
  screenshot: string;
};

export type FeedbackLogEntry = FeedbackSubmission & { id: string; at: string };

export type FeedbackLogOptions = {
  filePath: string | null;
  now?: () => number;
  newId?: () => string;
};

// Append-only JSONL of every feedback submission, then one line with its outcome, so a lost send is recoverable.
export class FeedbackLog {
  private writing: Promise<void> = Promise.resolve();
  private readonly now: () => number;
  private readonly newId: () => string;

  constructor(private readonly options: FeedbackLogOptions) {
    this.now = options.now ?? Date.now;
    this.newId = options.newId ?? randomUUID;
  }

  async record(submission: FeedbackSubmission): Promise<FeedbackLogEntry> {
    const entry: FeedbackLogEntry = { id: this.newId(), at: this.isoNow(), ...submission };
    await this.append(entry);
    return entry;
  }

  async outcome(entry: FeedbackLogEntry, result: FeedbackDeliveryResult): Promise<void> {
    if (result.outcome === "undelivered") {
      console.error(`Feedback ${entry.id} to ${entry.target} undelivered (${result.reason ?? "unknown reason"}): ${entry.text}`);
    }
    await this.append({ id: entry.id, at: this.isoNow(), outcome: result.outcome, ...(result.reason ? { reason: result.reason } : {}) });
  }

  async flush(): Promise<void> {
    await this.writing;
  }

  private isoNow(): string {
    return new Date(this.now()).toISOString();
  }

  // Never throws: a failed write still leaves the line in the server log.
  private append(line: Record<string, unknown>): Promise<void> {
    const filePath = this.options.filePath;
    const serialized = `${JSON.stringify(line)}\n`;
    if (!filePath) {
      return Promise.resolve();
    }
    this.writing = this.writing.then(async () => {
      await mkdir(path.dirname(filePath), { recursive: true });
      await appendFile(filePath, serialized);
    }).catch((error: unknown) => console.error(`Failed to append to the feedback log ${filePath}: ${serialized.trim()}`, error));
    return this.writing;
  }
}
