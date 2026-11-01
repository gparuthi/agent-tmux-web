import { describe, expect, it } from "vitest";

import {
  ansiSegmentStyle,
  applySgr,
  contrastRatio,
  ensureReadable,
  parseAnsiLines,
  safeHyperlinkHref,
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
    const lines = parseAnsiLines(`${ESC}[33myellow\nstill${ESC}[2K${ESC}]0;title${ESC}\\ here${ESC}[0m\n`);
    expect(lines[0]).toEqual([{ text: "yellow", style: { fg: { kind: "palette", index: 3 } } }]);
    expect(lines[1]).toEqual([{ text: "still here", style: { fg: { kind: "palette", index: 3 } } }]);
    expect(lines[2]).toEqual([]);
  });

  it("carries OSC 8 hyperlinks on segments until an empty URI closes them", () => {
    // Claude Code's artifact link, as tmux capture-pane -e prints it.
    const [line] = parseAnsiLines(`${ESC}[94m${ESC}]8;id=wj3jn3;https://claude.ai/artifact/8MPGRRU8S62TjzRxDxVVjd${ESC}\\Shelf${ESC}[39m${ESC}]8;;${ESC}\\. It's private to you.`);
    expect(line).toEqual([
      { text: "Shelf", style: { fg: { kind: "palette", index: 12 } }, href: "https://claude.ai/artifact/8MPGRRU8S62TjzRxDxVVjd" },
      { text: ". It's private to you.", style: {} }
    ]);
  });

  it("accepts BEL and ESC backslash terminators and splits segments at link edges with the same style", () => {
    const [line] = parseAnsiLines(`see ${ESC}]8;;https://a.test/x\u0007one${ESC}]8;;\u0007 and ${ESC}]8;;mailto:me@a.test${ESC}\\two${ESC}]8;;${ESC}\\ end`);
    expect(line).toEqual([
      { text: "see ", style: {} },
      { text: "one", style: {}, href: "https://a.test/x" },
      { text: " and ", style: {} },
      { text: "two", style: {}, href: "mailto:me@a.test" },
      { text: " end", style: {} }
    ]);
  });

  it("keeps a hyperlink open across lines like style", () => {
    const lines = parseAnsiLines(`${ESC}]8;;https://a.test/long\u0007first half\nsecond half${ESC}]8;;\u0007 after\nplain`);
    expect(lines).toEqual([
      [{ text: "first half", style: {}, href: "https://a.test/long" }],
      [{ text: "second half", style: {}, href: "https://a.test/long" }, { text: " after", style: {} }],
      [{ text: "plain", style: {} }]
    ]);
  });

  it("renders hyperlinks with disallowed or malformed URIs as plain text", () => {
    const [line] = parseAnsiLines(`${ESC}]8;;javascript:alert(1)\u0007bad${ESC}]8;;\u0007 ${ESC}]8;;file:///etc/passwd\u0007file${ESC}]8;;\u0007 ${ESC}]8;;not a url\u0007junk${ESC}]8;;\u0007`);
    expect(line).toEqual([{ text: "bad file junk", style: {} }]);
    expect(safeHyperlinkHref("https://a.test")).toBe("https://a.test/");
    expect(safeHyperlinkHref("data:text/html,x")).toBeUndefined();
    expect(safeHyperlinkHref("")).toBeUndefined();
  });

  it("strips every escape for plain text", () => {
    expect(stripAnsi(`${ESC}[38;5;231m✻ Claude${ESC}[39m ${ESC}]0;title\u0007ok`)).toBe("✻ Claude ok");
    expect(stripAnsi(`${ESC}]8;id=1;https://a.test${ESC}\\link${ESC}]8;;${ESC}\\.`)).toBe("link.");
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
