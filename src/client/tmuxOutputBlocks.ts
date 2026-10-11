import stringWidth from "string-width";

import { stripAnsi } from "./ansi.js";

export type TmuxOutputBlock =
  | { kind: "text"; start: number; end: number }
  | { kind: "table"; start: number; end: number; columns: number };

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
    if (table.start > cursor) blocks.push({ kind: "text", start: cursor, end: table.start });
    let columns = 0;
    for (let line = table.start; line < table.end; line += 1) {
      columns = Math.max(columns, stringWidth(plain[line] ?? ""));
    }
    blocks.push({ kind: "table", start: table.start, end: table.end, columns });
    cursor = table.end;
  }
  if (cursor < lines.length) blocks.push({ kind: "text", start: cursor, end: lines.length });
  return blocks;
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
