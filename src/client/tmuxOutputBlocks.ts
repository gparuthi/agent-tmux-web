import stringWidth from "string-width";

import { stripAnsi } from "./ansi.js";

export type TmuxOutputBlock =
  | { kind: "text"; start: number; end: number }
  | { kind: "table"; start: number; end: number; columns: number }
  | { kind: "rule"; start: number; end: number; rule: TmuxRule };

// Offsets index the ANSI-stripped line; an empty label has labelStart === labelEnd.
export type TmuxRule = {
  strokeStart: number;
  labelStart: number;
  labelEnd: number;
  align: "left" | "right";
  weight: "light" | "heavy" | "double";
};

export type TmuxTableFit = { mode: "natural" | "scaled" | "scroll"; fontSize: number; overflow: boolean };

// Tables up to this many times the view width shrink to fit; wider ones keep their size and scroll.
export const TMUX_TABLE_MAX_FIT_RATIO = 1.6;
export const TMUX_TABLE_MIN_FONT_SIZE = 9;

type LineKind = "border" | "row" | "lead" | "pipe" | "other";

const BOX_CHAR = /[─-╿]/u;
const BOX_CHARS = /[─-╿]/gu;
// Pure horizontal strokes: a line made only of these is a rule, not a table border.
const HORIZONTAL_ONLY = /^[─━═╌╍┄┅┈┉╴╶╸╺╼╾\s]+$/u;
const HORIZONTAL = /[─━═╌╍┄┅┈┉╴╶╸╺╼╾]/u;
const ROW_EDGE = /[│┃║╎╏┆┇┊┋├┤┝┥┞┟┠┡┢┣┦┧┨┩┪┫╞╟╠╡╢╣]/u;
const LEAD_EDGE = /[│┃║╎╏┆┇┊┋]/u;
const PIPE_SEPARATOR = /^\|?(?:\s*:?-{3,}:?\s*\|)+(?:\s*:?-{3,}:?\s*)?\|?$/u;
const RULE_STROKE = /[─━═╌╍┄┅┈┉╴╶╸╺╼╾\-=_‒–—―]/u;
const HEAVY_STROKE = /[━╍┅┉╸╺]/u;
const DOUBLE_STROKE = /[═=]/u;
export const TMUX_RULE_MIN_STROKES = 20;
export const TMUX_RULE_MIN_STROKE_RATIO = 0.8;

export function splitTmuxOutputBlocks(lines: readonly string[]): TmuxOutputBlock[] {
  if (lines.length === 0) {
    return [];
  }
  const plain = lines.map((line) => stripAnsi(line).trimEnd());
  const kinds = plain.map(classifyTableLine);
  const tables: Array<{ start: number; end: number }> = [];
  let index = 0;
  while (index < kinds.length) {
    const kind = kinds[index];
    if (kind === "pipe") {
      let end = index;
      while (end < kinds.length && kinds[end] === "pipe") end += 1;
      if (end - index >= 2) tables.push({ start: index, end });
      index = end;
      continue;
    }
    if (kind === "border" || kind === "row") {
      let end = index;
      while (end < kinds.length && (kinds[end] === "border" || kinds[end] === "row" || kinds[end] === "lead")) end += 1;
      // Left-edge-only lines count only when framed, so drop any trailing ones.
      let framedEnd = end;
      while (framedEnd > index && kinds[framedEnd - 1] === "lead") framedEnd -= 1;
      const hasBorder = kinds.slice(index, framedEnd).includes("border");
      if (framedEnd - index >= 2 && hasBorder) tables.push({ start: index, end: framedEnd });
      index = end;
      continue;
    }
    index += 1;
  }

  const blocks: TmuxOutputBlock[] = [];
  let cursor = 0;
  for (const table of tables) {
    if (table.start > cursor) pushTextBlocks(blocks, plain, cursor, table.start);
    let columns = 0;
    for (let line = table.start; line < table.end; line += 1) {
      columns = Math.max(columns, stringWidth(plain[line] ?? ""));
    }
    blocks.push({ kind: "table", start: table.start, end: table.end, columns });
    cursor = table.end;
  }
  if (cursor < lines.length) pushTextBlocks(blocks, plain, cursor, lines.length);
  return blocks;
}

// Rules only exist outside tables, so box borders stay with their table.
function pushTextBlocks(blocks: TmuxOutputBlock[], plain: readonly string[], start: number, end: number): void {
  let textStart = start;
  for (let index = start; index < end; index += 1) {
    const rule = detectTmuxRule(plain[index] ?? "");
    if (!rule) continue;
    if (index > textStart) blocks.push({ kind: "text", start: textStart, end: index });
    blocks.push({ kind: "rule", start: index, end: index + 1, rule });
    textStart = index + 1;
  }
  if (end > textStart) blocks.push({ kind: "text", start: textStart, end });
}

// A rule is a long horizontal stroke run, optionally carrying a short label such as Claude's session name.
export function detectTmuxRule(line: string): TmuxRule | null {
  const plain = stripAnsi(line);
  const trimmedEnd = plain.trimEnd();
  const strokeStart = trimmedEnd.length - trimmedEnd.trimStart().length;
  const first = trimmedEnd[strokeStart] ?? "";
  const last = trimmedEnd[trimmedEnd.length - 1] ?? "";
  if (!RULE_STROKE.test(first) || !RULE_STROKE.test(last)) {
    return null;
  }
  let strokes = 0;
  let visible = 0;
  let heavy = 0;
  let double = 0;
  let labelStart = -1;
  let labelEnd = -1;
  let offset = strokeStart;
  for (const char of trimmedEnd.slice(strokeStart)) {
    if (RULE_STROKE.test(char)) {
      strokes += 1;
      if (HEAVY_STROKE.test(char)) heavy += 1;
      if (DOUBLE_STROKE.test(char)) double += 1;
    } else if (!/\s/u.test(char)) {
      if (labelStart < 0) labelStart = offset;
      labelEnd = offset + char.length;
    }
    if (!/\s/u.test(char)) visible += 1;
    offset += char.length;
  }
  if (strokes < TMUX_RULE_MIN_STROKES || strokes / visible < TMUX_RULE_MIN_STROKE_RATIO) {
    return null;
  }
  const weight = heavy * 2 > strokes ? "heavy" : double * 2 > strokes ? "double" : "light";
  if (labelStart < 0) {
    return { strokeStart, labelStart: trimmedEnd.length, labelEnd: trimmedEnd.length, align: "left", weight };
  }
  const align = trimmedEnd.length - labelEnd < labelStart - strokeStart ? "right" : "left";
  return { strokeStart, labelStart, labelEnd, align, weight };
}

function classifyTableLine(line: string): LineKind {
  const trimmed = line.trim();
  if (trimmed.length < 2) {
    return "other";
  }
  const first = trimmed[0] ?? "";
  const last = trimmed[trimmed.length - 1] ?? "";
  if (first === "|" && (last === "|" || PIPE_SEPARATOR.test(trimmed))) {
    return trimmed.length >= 3 ? "pipe" : "other";
  }
  if (PIPE_SEPARATOR.test(trimmed)) {
    return "pipe";
  }
  if (BOX_CHAR.test(first) && BOX_CHAR.test(last) && HORIZONTAL.test(trimmed) && !HORIZONTAL_ONLY.test(trimmed)) {
    const visible = trimmed.replace(/\s+/gu, "");
    const boxCount = visible.match(BOX_CHARS)?.length ?? 0;
    if (boxCount / [...visible].length >= 0.6) {
      return "border";
    }
  }
  if (ROW_EDGE.test(first) && ROW_EDGE.test(last)) {
    return "row";
  }
  return LEAD_EDGE.test(first) ? "lead" : "other";
}

export function fitTmuxTable(options: {
  columns: number;
  available: number;
  charWidth: number;
  baseFontSize: number;
}): TmuxTableFit {
  const { columns, available, charWidth, baseFontSize } = options;
  const natural = columns * charWidth;
  if (available <= 0 || charWidth <= 0 || natural <= available) {
    return { mode: "natural", fontSize: baseFontSize, overflow: false };
  }
  if (natural / available > TMUX_TABLE_MAX_FIT_RATIO) {
    return { mode: "scroll", fontSize: baseFontSize, overflow: true };
  }
  // Round down to a tenth of a pixel so sub-pixel glyph rounding never overflows by a hair.
  const fitted = Math.floor((baseFontSize * available / natural) * 10) / 10;
  const fontSize = Math.max(TMUX_TABLE_MIN_FONT_SIZE, Math.min(baseFontSize, fitted));
  return { mode: "scaled", fontSize, overflow: columns * charWidth * (fontSize / baseFontSize) > available };
}
