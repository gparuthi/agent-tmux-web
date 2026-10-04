import { describe, expect, it } from "vitest";

import { looksLikeTmuxDone, looksLikeTmuxWaitingForInput, looksLikeTmuxWorking } from "../../shared/tmuxActivity.js";
import { classifyTmuxStatus, mergeTmuxSessionStatus, resolveTmuxSessionStatus } from "../../shared/tmuxStatus.js";

describe("tmux activity detection", () => {
  it("detects Codex working output", () => {
    expect(looksLikeTmuxWorking("• Working (12s • esc to interrupt)")).toBe(true);
    expect(looksLikeTmuxWaitingForInput("• Working (12s • esc to interrupt)")).toBe(false);
  });

  it("detects live OpenCode working and waiting footers", () => {
    const workingFooter = "⬝⬝⬝■■■■■  esc interrupt    174.0K (35%)  ctrl+p commands    • OpenCode 1.18.4";
    const waitingFooter = "/workspace/project  139.6K (28%)  ctrl+p commands";

    expect(looksLikeTmuxWorking(workingFooter)).toBe(true);
    expect(looksLikeTmuxWaitingForInput(workingFooter)).toBe(false);
    expect(classifyTmuxStatus({ output: workingFooter }).kind).toBe("working");
    expect(looksLikeTmuxWorking(waitingFooter)).toBe(false);
    expect(looksLikeTmuxWaitingForInput(waitingFooter)).toBe(true);
    expect(classifyTmuxStatus({ output: waitingFooter })).toMatchObject({ kind: "idle", title: "Idle" });
  });

  it("detects a Codex input prompt after work completes", () => {
    expect(looksLikeTmuxWaitingForInput([
      "Implemented the requested change.",
      "Verified tests.",
      "│ › │"
    ].join("\n"))).toBe(true);
  });

  it("detects shell-style prompts", () => {
    expect(looksLikeTmuxWaitingForInput("pnpm test\n40 tests passed\nagent-demo $")).toBe(true);
    expect(looksLikeTmuxWaitingForInput("developer in ~/work/project\n❯")).toBe(true);
  });

  it("does not treat old user prompts as idle state", () => {
    expect(looksLikeTmuxWaitingForInput("› Review the release checklist\n• Still running analysis")).toBe(false);
  });

  it("detects Codex completion status even when no prompt line is visible", () => {
    expect(looksLikeTmuxWaitingForInput([
      "Implemented the requested change.",
      "Verified tests.",
      "› Summarize recent commits",
      "gpt-5.5 xhigh fast · ~/dev                                Goal achieved (5m)"
    ].join("\n"))).toBe(true);
  });

  it("does not let older working lines block a later completion status", () => {
    expect(looksLikeTmuxWorking([
      "• Working (45s • esc to interrupt)",
      "",
      "Done.",
      "gpt-5.5 xhigh fast · ~/dev                                Goal achieved (1m)"
    ].join("\n"))).toBe(false);
    expect(looksLikeTmuxWaitingForInput([
      "• Working (45s • esc to interrupt)",
      "",
      "Done.",
      "gpt-5.5 xhigh fast · ~/dev                                Goal achieved (1m)"
    ].join("\n"))).toBe(true);
  });

  it("uses a newer ordinary prompt instead of an older working line", () => {
    const output = [
      "• Working (45s • esc to interrupt)",
      "Done.",
      "agent-demo $"
    ].join("\n");

    expect(looksLikeTmuxWorking(output)).toBe(false);
    expect(looksLikeTmuxWaitingForInput(output)).toBe(true);
  });

  it("does not let an old completion marker override newer work", () => {
    const output = [
      "Goal achieved",
      "• Working (3s • esc to interrupt)"
    ].join("\n");

    expect(looksLikeTmuxWorking(output)).toBe(true);
    expect(looksLikeTmuxWaitingForInput(output)).toBe(false);
  });

  it("orders generic questions and permission prompts against working output", () => {
    expect(looksLikeTmuxWaitingForInput([
      "• Working (3s • esc to interrupt)",
      "Allow this command? [y/N]"
    ].join("\n"))).toBe(true);
    expect(looksLikeTmuxWorking([
      "Which branch should I use?",
      "• Working (3s • esc to interrupt)"
    ].join("\n"))).toBe(true);
  });

  it("detects Codex confirmation prompts as waiting for input", () => {
    expect(looksLikeTmuxWaitingForInput([
      "Replace goal?",
      "› 1. Replace current goal  Set the new objective and start it now",
      "  2. Cancel                Keep the current goal",
      "Press enter to confirm or esc to go back"
    ].join("\n"))).toBe(true);
  });

  it("maps the screen onto gpmon's five states", () => {
    expect(classifyTmuxStatus({ output: "Working (3s • esc to interrupt)" })).toEqual({ kind: "working", title: "Working", source: "atw" });
    expect(classifyTmuxStatus({ output: "Allow this command? [y/N]" })).toEqual({ kind: "blocked", title: "Needs permission", source: "atw" });
    expect(classifyTmuxStatus({ output: "Done.\n─ Worked for 1m 23s ─────────" })).toEqual({ kind: "done", title: "Done", source: "atw" });
    expect(classifyTmuxStatus({ output: "quiet output" })).toEqual({ kind: "idle", title: "Idle", source: "atw" });
  });

  it("has no error state: failures read as whatever else the screen says", () => {
    expect(classifyTmuxStatus({ output: "Error: command failed" }).kind).toBe("idle");
    expect(classifyTmuxStatus({ output: "bash: nope: command not found\nuser@host $" }).kind).toBe("idle");
    expect(classifyTmuxStatus({ output: "Traceback (most recent call last)\nWorking (3s • esc to interrupt)" }).kind).toBe("working");
    const kinds = ["Error: x", "failed", "exit code 2", "FAIL a.test.ts\n❯"].map((output) => classifyTmuxStatus({ output }).kind);
    expect(kinds).not.toContain("error");
  });

  it("treats a finished turn as done until newer work or a question appears", () => {
    expect(looksLikeTmuxDone("Answer.\n✻ Worked for 2m 3s\n❯")).toBe(true);
    expect(looksLikeTmuxDone("Answer.\nTask complete\n›")).toBe(true);
    expect(looksLikeTmuxDone("Answer.\n─ Worked for 1m ─────\n• Working (3s • esc to interrupt)")).toBe(false);
    expect(looksLikeTmuxDone("─ Worked for 1m ─────\nAllow this command? [y/N]")).toBe(false);
    expect(looksLikeTmuxDone("quiet output\n❯")).toBe(false);
  });

  it("keeps visible blocked states ahead of native harness status", () => {
    const working = classifyTmuxStatus({ output: "Working (3s • esc to interrupt)" });
    expect(mergeTmuxSessionStatus(classifyTmuxStatus({ output: "Error: command failed" }), working).kind).toBe("working");
    expect(mergeTmuxSessionStatus(classifyTmuxStatus({ output: "Allow this command? [y/N]" }), working).kind).toBe("blocked");
    expect(mergeTmuxSessionStatus(classifyTmuxStatus({ output: "quiet output" }), working).kind).toBe("working");
  });

  it("prefers gpmon's row over the screen and the harness", () => {
    const gpmonIdle = { kind: "idle", title: "Idle 12m", source: "gpmon" } as const;
    const gpmonBlocked = { kind: "blocked", title: "Blocked", source: "gpmon" } as const;
    const working = classifyTmuxStatus({ output: "Working (3s • esc to interrupt)" });
    const permission = classifyTmuxStatus({ output: "Allow this command? [y/N]" });

    expect(resolveTmuxSessionStatus(gpmonIdle, working, working)).toEqual(gpmonIdle);
    expect(resolveTmuxSessionStatus(gpmonIdle, permission)).toEqual(gpmonIdle);
    expect(resolveTmuxSessionStatus({ kind: "unknown", title: "Unknown", source: "gpmon" }, working).kind).toBe("unknown");
    // A bare gpmon "blocked" borrows the screen's reason for the tooltip.
    expect(resolveTmuxSessionStatus(gpmonBlocked, permission)).toEqual({ kind: "blocked", title: "Needs permission", source: "gpmon" });
    expect(resolveTmuxSessionStatus(gpmonBlocked, working)).toEqual(gpmonBlocked);
    // No fresh gpmon row: screen heuristics merged with the opencode harness.
    expect(resolveTmuxSessionStatus(undefined, classifyTmuxStatus({ output: "quiet output" }), working).kind).toBe("working");
    expect(resolveTmuxSessionStatus(undefined, permission, working).kind).toBe("blocked");
    expect(resolveTmuxSessionStatus(undefined, classifyTmuxStatus({ output: "quiet output" })).kind).toBe("idle");
  });

  it("marks blocked only for visible choices or approvals", () => {
    expect(classifyTmuxStatus({ output: "Which branch should I use?\nctrl+p commands" }))
      .toMatchObject({ kind: "idle" });
    expect(classifyTmuxStatus({ output: "Next steps:\n1. Create an account\n2. Configure the repository\nctrl+p commands" }))
      .toMatchObject({ kind: "idle" });
    expect(classifyTmuxStatus({ output: "Choose a branch:\n› 1. main\n  2. release\nPress enter to confirm or esc to go back" }))
      .toMatchObject({ kind: "blocked", title: "Asking a question" });
    expect(classifyTmuxStatus({ output: "Allow this command? [y/N]" }))
      .toMatchObject({ kind: "blocked", title: "Needs permission" });
  });

  it("lets the current idle prompt clear historical failures", () => {
    const completedRun = [
      "FAIL src/server/example.test.ts",
      "AssertionError: expected waiting but received idle",
      "The tests were fixed and now pass.",
      "Build auto · GPT-5.6 Sol · xhigh",
      "/workspace/project  ctrl+p commands"
    ].join("\n");

    expect(classifyTmuxStatus({ output: completedRun })).toMatchObject({ kind: "idle" });
  });

  it("lets the current idle prompt clear historical approval controls", () => {
    const completedApproval = [
      "Allow this command? [y/N]",
      "Approved and completed.",
      "/workspace/project  ctrl+p commands"
    ].join("\n");

    expect(classifyTmuxStatus({ output: completedApproval })).toMatchObject({ kind: "idle" });
  });
});
