import { describe, expect, it, vi } from "vitest";

import type { AgentRow, AgentRowsSnapshot } from "../agentRows.js";
import { renameWhenReady } from "../agentStartName.js";

function snapshot(row?: Partial<AgentRow>): AgentRowsSnapshot {
  const rows = new Map<string, AgentRow>();
  if (row) {
    rows.set("%7", { paneId: "%7", kind: "codex", status: "idle", ...row });
  }
  return { epochSec: 1, rows };
}

describe("renameWhenReady", () => {
  it("waits for the pane to show up idle, then submits the agent's rename command", async () => {
    const reads = [null, snapshot(), snapshot({ status: "working" }), snapshot({ status: "idle" })];
    const submitText = vi.fn(async () => undefined);
    const sleep = vi.fn(async () => undefined);
    const renamed = await renameWhenReady({ pane: "%7", agent: "codex", name: "fix auth", readRows: async () => reads.shift() ?? null, submitText, sleep });
    expect(renamed).toBe(true);
    expect(submitText).toHaveBeenCalledOnce();
    expect(submitText).toHaveBeenCalledWith("%7", "/rename fix auth");
    expect(sleep).toHaveBeenCalledTimes(3);
  });

  it("never types into a blocked pane or a different agent, and gives up at the timeout", async () => {
    const submitText = vi.fn(async () => undefined);
    const sleep = vi.fn(async () => undefined);
    const blocked = await renameWhenReady({
      pane: "%7", agent: "codex", name: "x", readRows: async () => snapshot({ status: "blocked" }), submitText, sleep, pollMs: 1000, timeoutMs: 3000
    });
    const other = await renameWhenReady({
      pane: "%7", agent: "codex", name: "x", readRows: async () => snapshot({ kind: "claude" }), submitText, sleep, pollMs: 1000, timeoutMs: 3000
    });
    expect(blocked).toBe(false);
    expect(other).toBe(false);
    expect(submitText).not.toHaveBeenCalled();
    expect(sleep).toHaveBeenCalledTimes(6);
  });
});
