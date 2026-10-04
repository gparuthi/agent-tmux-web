import { describe, expect, it } from "vitest";

import {
  ansiSegmentStyle,
  applySgr,
  contrastRatio,
  ensureReadable,
  parseAnsiLines,
  stripAnsi,
  THEME_OUTPUT_COLORS,
  xtermPaletteRgb
} from "../ansi.js";

const ESC = "\u001b";

describe("parseAnsiLines", () => {
  it("splits text into styled segments and resets", () => {
    const [line] = parseAnsiLines(`plain ${ESC}[31mred${ESC}[0m ${ESC}[1;32mbold green${ESC}[22m green${ESC}[39m done`);
    expect(line?.map((segment) => [segment.text, segment.style])).toEqual([
      ["plain ", {}],
      ["red", { fg: { kind: "palette", index: 1 } }],
      [" ", {}],
      ["bold green", { fg: { kind: "palette", index: 2 }, bold: true }],
      [" green", { fg: { kind: "palette", index: 2 } }],
      [" done", {}]
    ]);
  });

  it("parses 256-colour and truecolor in semicolon and colon forms", () => {
    expect(applySgr({}, "38;5;208").fg).toEqual({ kind: "palette", index: 208 });
    expect(applySgr({}, "48;2;10;20;30").bg).toEqual({ kind: "rgb", r: 10, g: 20, b: 30 });
    expect(applySgr({}, "38:5:153").fg).toEqual({ kind: "palette", index: 153 });
    expect(applySgr({}, "38:2::1:2:3").fg).toEqual({ kind: "rgb", r: 1, g: 2, b: 3 });
    expect(applySgr({}, "38:2:1:2:3").fg).toEqual({ kind: "rgb", r: 1, g: 2, b: 3 });
    // Parameters after an extended colour still apply.
    expect(applySgr({}, "38;5;196;1;48;5;237")).toEqual({
      fg: { kind: "palette", index: 196 },
      bg: { kind: "palette", index: 237 },
      bold: true
    });
    expect(applySgr({}, "91;104")).toEqual({ fg: { kind: "palette", index: 9 }, bg: { kind: "palette", index: 12 } });
    expect(applySgr({ fg: { kind: "palette", index: 1 } }, "")).toEqual({});
    expect(applySgr({}, "4:3;7;9")).toEqual({ underline: true, inverse: true, strike: true });
  });

  it("carries style across lines and drops non-SGR escapes", () => {
    const lines = parseAnsiLines(`${ESC}[33myellow\nstill${ESC}[2K${ESC}]8;;https://x.test${ESC}\\link${ESC}]8;;${ESC}\\${ESC}[0m\n`);
    expect(lines[0]).toEqual([{ text: "yellow", style: { fg: { kind: "palette", index: 3 } } }]);
    expect(lines[1]).toEqual([{ text: "stilllink", style: { fg: { kind: "palette", index: 3 } } }]);
    expect(lines[2]).toEqual([]);
  });

  it("strips every escape for plain text", () => {
    expect(stripAnsi(`${ESC}[38;5;231m✻ Claude${ESC}[39m ${ESC}]0;title\u0007ok`)).toBe("✻ Claude ok");
  });
});

describe("ansi colours", () => {
  it("maps the xterm 256-colour palette", () => {
    expect(xtermPaletteRgb(1)).toEqual([205, 0, 0]);
    expect(xtermPaletteRgb(16)).toEqual([0, 0, 0]);
    expect(xtermPaletteRgb(208)).toEqual([255, 135, 0]);
    expect(xtermPaletteRgb(231)).toEqual([255, 255, 255]);
    expect(xtermPaletteRgb(244)).toEqual([128, 128, 128]);
  });

  it("darkens light colours on the light theme and lightens dark ones on the dark theme", () => {
    const white: [number, number, number] = [255, 255, 255];
    expect(contrastRatio(ensureReadable(white, "light"), THEME_OUTPUT_COLORS.light.background)).toBeGreaterThanOrEqual(3);
    expect(ensureReadable(white, "dark")).toEqual(white);
    const black: [number, number, number] = [0, 0, 0];
    expect(contrastRatio(ensureReadable(black, "dark"), THEME_OUTPUT_COLORS.dark.background)).toBeGreaterThanOrEqual(3);
  });

  it("builds readable inline styles for each theme", () => {
    const claudeWhite = applySgr({}, "38;5;231");
    expect(ansiSegmentStyle(claudeWhite, "dark")).toEqual({ color: "rgb(255, 255, 255)" });
    expect(ansiSegmentStyle(claudeWhite, "light")?.color).not.toBe("rgb(255, 255, 255)");
    expect(ansiSegmentStyle(applySgr({}, "31"), "light")).toEqual({ color: "#c0262d" });
    expect(ansiSegmentStyle(applySgr({}, "31"), "dark")).toEqual({ color: "#ff6b6b" });
    // A program-chosen background keeps its colours; default text picks a readable shade.
    expect(ansiSegmentStyle(applySgr({}, "48;5;237"), "light")).toEqual({
      backgroundColor: "rgb(58, 58, 58)",
      color: "rgb(240, 244, 246)"
    });
    expect(ansiSegmentStyle(applySgr({}, "7"), "dark")).toEqual({
      backgroundColor: "rgb(216, 222, 226)",
      color: "rgb(13, 15, 16)"
    });
    expect(ansiSegmentStyle(applySgr({}, "1;2;3;4;9"), "dark")).toEqual({
      fontWeight: 650,
      opacity: 0.7,
      fontStyle: "italic",
      textDecoration: "underline line-through"
    });
    expect(ansiSegmentStyle({}, "dark")).toBeUndefined();
  });
});
