import { describe, expect, it } from "vitest";

import {
  TMUX_TABLE_MAX_FIT_RATIO,
  TMUX_TABLE_MIN_FONT_SIZE,
  fitTmuxTable,
  splitTmuxOutputBlocks,
  type TmuxOutputBlock
} from "../tmuxOutputBlocks.js";

function split(output: string): TmuxOutputBlock[] {
  return splitTmuxOutputBlocks(output.split("\n"));
}

function tables(output: string) {
  return split(output).filter((block) => block.kind === "table");
}

describe("splitTmuxOutputBlocks", () => {
  it("returns no blocks for no lines and one text block for an empty capture", () => {
    expect(splitTmuxOutputBlocks([])).toEqual([]);
    expect(splitTmuxOutputBlocks([""])).toEqual([{ kind: "text", start: 0, end: 1 }]);
  });

  it("finds a Claude box table between prose", () => {
    const output = [
      "⏺ Here is how the three deploy options compare:",
      "",
      "  ┌──────────────┬──────────────────────────────┬─────────────┐",
      "  │ Option       │ What it does                 │ Verdict     │",
      "  ├──────────────┼──────────────────────────────┼─────────────┤",
      "  │ launchd      │ Runs atw as a per-user agent │ Recommended │",
      "  ├──────────────┼──────────────────────────────┼─────────────┤",
      "  │ tmux respawn │ Keeps the server in a window │ Fallback    │",
      "  └──────────────┴──────────────────────────────┴─────────────┘",
      "",
      "  Let me know which one to wire up."
    ].join("\n");
    expect(split(output)).toEqual([
      { kind: "text", start: 0, end: 2 },
      { kind: "table", start: 2, end: 9, columns: 63 },
      { kind: "text", start: 9, end: 11 }
    ]);
  });

  it("keeps a Claude cell that wraps onto a second row inside the table", () => {
    const output = [
      "  ┌───────┬──────────────────┐",
      "  │ File  │ Notes            │",
      "  ├───────┼──────────────────┤",
      "  │ a.ts  │ split the parser │",
      "  │       │ into two passes  │",
      "  └───────┴──────────────────┘"
    ].join("\n");
    expect(split(output)).toEqual([{ kind: "table", start: 0, end: 6, columns: 30 }]);
  });

  it("finds Codex rounded and heavy box frames", () => {
    const output = [
      "╭──────────────────────────────────────────╮",
      "│ >_ OpenAI Codex (v0.46.0)                │",
      "│                                          │",
      "│ model:    gpt-5-codex   /model to change │",
      "╰──────────────────────────────────────────╯",
      "",
      "┏━━━━━━┳━━━━━━┓",
      "┃ a    ┃ b    ┃",
      "┗━━━━━━┻━━━━━━┛"
    ].join("\n");
    expect(tables(output)).toEqual([
      { kind: "table", start: 0, end: 5, columns: 44 },
      { kind: "table", start: 6, end: 9, columns: 15 }
    ]);
  });

  it("finds Codex markdown pipe tables, with and without outer pipes on the separator", () => {
    const output = [
      "• Summary of the change:",
      "",
      "  | File          | Change          |",
      "  |---------------|-----------------|",
      "  | tmux.ts       | capture flags   |",
      "  | styles.css    | table scrolling |",
      "",
      "| a | b |",
      "|:---|---:|",
      "",
      "| only one pipe row |"
    ].join("\n");
    expect(tables(output)).toEqual([
      { kind: "table", start: 2, end: 6, columns: 37 },
      { kind: "table", start: 7, end: 9, columns: 11 }
    ]);
  });

  it("finds a table whose rows carry ANSI colours and measures visible columns only", () => {
    const output = [
      "\u001b[2m  ┌────────┬───────┐\u001b[0m",
      "  │ \u001b[1mCheck\u001b[0m  │ Count │",
      "  ├────────┼───────┤",
      "  │ \u001b[32mtests\u001b[0m  │ \u001b[38;5;214m812\u001b[0m   │   \u001b[0m",
      "  └────────┴───────┘"
    ].join("\n");
    expect(split(output)).toEqual([{ kind: "table", start: 0, end: 5, columns: 20 }]);
  });

  it("leaves a prose line with a single box bar as prose", () => {
    const output = [
      "The tests pass │ the build is green and the release notes are drafted.",
      "│ quoted context from the previous turn",
      "Everything else is unchanged."
    ].join("\n");
    expect(split(output)).toEqual([{ kind: "text", start: 0, end: 3 }]);
  });

  it("does not treat horizontal rules, prompt frames or tree output as tables", () => {
    const output = [
      "────────────────────────────────────────────────────",
      "> type a message",
      "────────────────────────────────────────────────────",
      "src",
      "├── client",
      "│   ├── App.tsx",
      "│   └── styles.css",
      "└── server",
      "─ Worked for 1m 12s ───────────────────────────────"
    ].join("\n");
    expect(tables(output)).toEqual([]);
  });

  it("needs at least two lines and a border for a box table", () => {
    expect(tables("  ┌──────┐")).toEqual([]);
    expect(tables(["│ a │ b │", "│ c │ d │"].join("\n"))).toEqual([]);
    expect(tables(["┌──┬──┐", "└──┴──┘"].join("\n"))).toEqual([{ kind: "table", start: 0, end: 2, columns: 7 }]);
  });

  it("keeps left-edge-only lines when a border frames them and drops trailing ones", () => {
    const output = [
      "┌──────────────┐",
      "│ framed text",
      "└──────────────┘",
      "│ trailing quote"
    ].join("\n");
    expect(split(output)).toEqual([
      { kind: "table", start: 0, end: 3, columns: 16 },
      { kind: "text", start: 3, end: 4 }
    ]);
  });

  it("counts wide CJK and emoji cells as two columns", () => {
    const output = [
      "| name | kind |",
      "|------|------|",
      "| 漢字 | ✅   |"
    ].join("\n");
    expect(tables(output)).toEqual([{ kind: "table", start: 0, end: 3, columns: 15 }]);
  });
});

describe("fitTmuxTable", () => {
  const base = { available: 350, charWidth: 7.2, baseFontSize: 12 };

  it("leaves tables that already fit alone", () => {
    expect(fitTmuxTable({ ...base, columns: 40 })).toEqual({ mode: "natural", fontSize: 12, overflow: false });
  });

  it("shrinks slightly wide tables to fit", () => {
    const fit = fitTmuxTable({ ...base, columns: 61 });
    expect(fit.mode).toBe("scaled");
    expect(fit.overflow).toBe(false);
    expect(fit.fontSize).toBeGreaterThanOrEqual(TMUX_TABLE_MIN_FONT_SIZE);
    expect(61 * 7.2 * (fit.fontSize / 12)).toBeLessThanOrEqual(350);
  });

  it("stops shrinking at the font floor and lets the rest scroll", () => {
    const columns = Math.floor((350 * TMUX_TABLE_MAX_FIT_RATIO) / 7.2);
    expect(fitTmuxTable({ ...base, columns })).toEqual({ mode: "scaled", fontSize: TMUX_TABLE_MIN_FONT_SIZE, overflow: true });
  });

  it("keeps the normal font and scrolls tables far wider than the view", () => {
    expect(fitTmuxTable({ ...base, columns: 169 })).toEqual({ mode: "scroll", fontSize: 12, overflow: true });
  });

  it("does not scale before the view has a width", () => {
    expect(fitTmuxTable({ ...base, available: 0, columns: 169 })).toEqual({ mode: "natural", fontSize: 12, overflow: false });
  });
});
