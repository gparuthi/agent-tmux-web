import type { CSSProperties } from "react";

import type { ColorTheme } from "./theme.js";

export type AnsiColor = { kind: "palette"; index: number } | { kind: "rgb"; r: number; g: number; b: number };

export type AnsiStyle = {
  fg?: AnsiColor;
  bg?: AnsiColor;
  bold?: true;
  dim?: true;
  italic?: true;
  underline?: true;
  inverse?: true;
  hidden?: true;
  strike?: true;
};

export type AnsiSegment = { text: string; style: AnsiStyle };

type Rgb = [number, number, number];

// CSI (SGR when the final byte is "m"), OSC (titles, hyperlinks), and other two-byte escapes.
const ESCAPE_PATTERN = /\u001b\[([0-9;:?<=>]*)[ -/]*([@-~])|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;

export function stripAnsi(text: string): string {
  return text.replace(ESCAPE_PATTERN, "");
}

export function hasAnsi(text: string): boolean {
  return text.includes("\u001b");
}

export function parseAnsiLines(output: string): AnsiSegment[][] {
  let style: AnsiStyle = {};
  return output.split(/\r?\n/).map((line) => {
    const segments: AnsiSegment[] = [];
    let cursor = 0;
    const push = (text: string) => {
      if (!text) {
        return;
      }
      const last = segments[segments.length - 1];
      if (last && last.style === style) {
        last.text += text;
      } else {
        segments.push({ text, style });
      }
    };
    for (const match of line.matchAll(ESCAPE_PATTERN)) {
      push(line.slice(cursor, match.index));
      cursor = (match.index ?? 0) + match[0].length;
      if (match[2] === "m" && match[0].startsWith("\u001b[")) {
        style = applySgr(style, match[1] ?? "");
      }
    }
    push(line.slice(cursor));
    return segments;
  });
}

export function applySgr(current: AnsiStyle, params: string): AnsiStyle {
  const tokens = params === "" ? ["0"] : params.split(";");
  const next: AnsiStyle = { ...current };
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] ?? "";
    const parts = token.split(":");
    const code = parts[0] === "" ? 0 : Number(parts[0]);
    if (code === 38 || code === 48 || code === 58) {
      let color: AnsiColor | undefined;
      if (parts.length > 1) {
        color = parseExtendedColor(parts.slice(1), true);
      } else {
        const rest = tokens.slice(index + 1);
        color = parseExtendedColor(rest, false);
        index += rest[0] === "5" ? 2 : rest[0] === "2" ? 4 : 0;
      }
      if (color && code === 38) next.fg = color;
      if (color && code === 48) next.bg = color;
      continue;
    }
    applySgrCode(next, code, parts);
  }
  return sameStyle(current, next) ? current : next;
}

function parseExtendedColor(parts: string[], colonForm: boolean): AnsiColor | undefined {
  const mode = parts[0];
  if (mode === "5") {
    const paletteIndex = Number(parts[1]);
    return Number.isInteger(paletteIndex) && paletteIndex >= 0 && paletteIndex <= 255 ? { kind: "palette", index: paletteIndex } : undefined;
  }
  if (mode === "2") {
    // Colon form may carry a colour-space id before r:g:b ("2::r:g:b" or "2:id:r:g:b").
    const values = colonForm && parts.length >= 5 ? parts.slice(parts.length - 3) : parts.slice(1, 4);
    const [r, g, b] = values.map(Number);
    if ([r, g, b].every((value) => Number.isInteger(value) && value >= 0 && value <= 255)) {
      return { kind: "rgb", r: r as number, g: g as number, b: b as number };
    }
  }
  return undefined;
}

function applySgrCode(style: AnsiStyle, code: number, parts: string[]): void {
  if (code === 0) {
    for (const key of Object.keys(style) as Array<keyof AnsiStyle>) delete style[key];
  } else if (code === 1) style.bold = true;
  else if (code === 2) style.dim = true;
  else if (code === 3) style.italic = true;
  else if (code === 4) {
    if (parts[1] === "0") delete style.underline;
    else style.underline = true;
  } else if (code === 7) style.inverse = true;
  else if (code === 8) style.hidden = true;
  else if (code === 9) style.strike = true;
  else if (code === 22) {
    delete style.bold;
    delete style.dim;
  } else if (code === 23) delete style.italic;
  else if (code === 24) delete style.underline;
  else if (code === 27) delete style.inverse;
  else if (code === 28) delete style.hidden;
  else if (code === 29) delete style.strike;
  else if (code >= 30 && code <= 37) style.fg = { kind: "palette", index: code - 30 };
  else if (code === 39) delete style.fg;
  else if (code >= 40 && code <= 47) style.bg = { kind: "palette", index: code - 40 };
  else if (code === 49) delete style.bg;
  else if (code >= 90 && code <= 97) style.fg = { kind: "palette", index: code - 90 + 8 };
  else if (code >= 100 && code <= 107) style.bg = { kind: "palette", index: code - 100 + 8 };
}

function sameStyle(left: AnsiStyle, right: AnsiStyle): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

// Fg-only 16-colour text, tuned for each theme's output background.
const THEME_PALETTES: Record<ColorTheme, string[]> = {
  dark: [
    "#5c666d", "#ff6b6b", "#7bd88f", "#e5c07b", "#61afef", "#c678dd", "#56b6c2", "#d8dee2",
    "#8a969e", "#ff8787", "#98e6a8", "#f0d58a", "#82c4ff", "#d99cf0", "#7fd3dc", "#ffffff"
  ],
  light: [
    "#1f2a32", "#c0262d", "#18794e", "#8a6200", "#1f5fbf", "#8b3fb3", "#0e7490", "#5b6b75",
    "#6b7780", "#d63a3a", "#1f8a5b", "#9a6b00", "#2a6fd6", "#9d4cc4", "#13849f", "#111820"
  ]
};

// Standard xterm colours, used when the program also chose the background.
const XTERM_BASE: Rgb[] = [
  [0, 0, 0], [205, 0, 0], [0, 205, 0], [205, 205, 0], [0, 0, 238], [205, 0, 205], [0, 205, 205], [229, 229, 229],
  [127, 127, 127], [255, 0, 0], [0, 255, 0], [255, 255, 0], [92, 92, 255], [255, 0, 255], [0, 255, 255], [255, 255, 255]
];

export const THEME_OUTPUT_COLORS: Record<ColorTheme, { background: Rgb; foreground: Rgb }> = {
  dark: { background: [13, 15, 16], foreground: [216, 222, 226] },
  light: { background: [255, 255, 255], foreground: [23, 32, 38] }
};

const MIN_CONTRAST = 3;

export function xtermPaletteRgb(index: number): Rgb {
  if (index < 16) {
    return XTERM_BASE[index] as Rgb;
  }
  if (index < 232) {
    const cube = index - 16;
    const level = (value: number) => (value === 0 ? 0 : 55 + value * 40);
    return [level(Math.floor(cube / 36)), level(Math.floor(cube / 6) % 6), level(cube % 6)];
  }
  const gray = 8 + (index - 232) * 10;
  return [gray, gray, gray];
}

function colorRgb(color: AnsiColor): Rgb {
  return color.kind === "rgb" ? [color.r, color.g, color.b] : xtermPaletteRgb(color.index);
}

function relativeLuminance([r, g, b]: Rgb): number {
  const channel = (value: number) => {
    const normalized = value / 255;
    return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function contrastRatio(left: Rgb, right: Rgb): number {
  const [light, dark] = [relativeLuminance(left), relativeLuminance(right)].sort((a, b) => b - a) as [number, number];
  return (light + 0.05) / (dark + 0.05);
}

// Darken (light theme) or lighten (dark theme) a colour until it reads against the output background.
export function ensureReadable(color: Rgb, theme: ColorTheme): Rgb {
  const background = THEME_OUTPUT_COLORS[theme].background;
  const target: Rgb = theme === "light" ? [0, 0, 0] : [255, 255, 255];
  let current = color;
  for (let step = 0; step < 12 && contrastRatio(current, background) < MIN_CONTRAST; step += 1) {
    current = current.map((value, channel) => Math.round(value + (target[channel] as number - value) * 0.2)) as Rgb;
  }
  return current;
}

function css([r, g, b]: Rgb): string {
  return `rgb(${r}, ${g}, ${b})`;
}

function pickTextOn(background: Rgb): Rgb {
  return relativeLuminance(background) > 0.35 ? [17, 24, 32] : [240, 244, 246];
}

export function ansiSegmentStyle(style: AnsiStyle, theme: ColorTheme): CSSProperties | undefined {
  const result: CSSProperties = {};
  let fg = style.fg;
  let bg = style.bg;
  if (style.inverse) {
    [fg, bg] = [bg, fg];
    const defaults = THEME_OUTPUT_COLORS[theme];
    const fgRgb = fg ? colorRgb(fg) : defaults.background;
    const bgRgb = bg ? colorRgb(bg) : defaults.foreground;
    result.color = css(fgRgb);
    result.backgroundColor = css(bgRgb);
  } else if (bg) {
    // The program picked both colours (diff rows, status bars): keep them as designed.
    const bgRgb = colorRgb(bg);
    result.backgroundColor = css(bgRgb);
    result.color = css(fg ? colorRgb(fg) : pickTextOn(bgRgb));
  } else if (fg) {
    result.color = fg.kind === "palette" && fg.index < 16
      ? THEME_PALETTES[theme][fg.index]
      : css(ensureReadable(colorRgb(fg), theme));
  }
  if (style.bold) result.fontWeight = 650;
  if (style.dim) result.opacity = 0.7;
  if (style.italic) result.fontStyle = "italic";
  const decorations = [style.underline ? "underline" : "", style.strike ? "line-through" : ""].filter(Boolean);
  if (decorations.length > 0) result.textDecoration = decorations.join(" ");
  if (style.hidden) result.visibility = "hidden";
  return Object.keys(result).length > 0 ? result : undefined;
}
