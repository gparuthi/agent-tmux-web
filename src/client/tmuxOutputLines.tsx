import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type UIEvent } from "react";

import { ansiSegmentStyle, hasAnsi, parseAnsiLines, type AnsiSegment } from "./ansi.js";
import { LinkifiedText } from "./LinkifiedText.js";
import type { ColorTheme } from "./theme.js";
import { fitTmuxTable, splitTmuxOutputBlocks } from "./tmuxOutputBlocks.js";

type TmuxOutputLinesProps = { output: string; anchors?: boolean; theme?: ColorTheme };

type TableMetrics = { available: number; charWidth: number; baseFontSize: number };

const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;
const charWidthCache = new Map<string, number>();

export const TmuxOutputLines = memo(function TmuxOutputLines({ output, anchors = true, theme = "dark" }: TmuxOutputLinesProps) {
  const lines = useMemo(() => output.split(/\r?\n/), [output]);
  const colored = hasAnsi(output);
  const parsed = useMemo(() => (colored ? parseAnsiLines(output) : null), [colored, output]);
  const blocks = useMemo(() => splitTmuxOutputBlocks(lines), [lines]);

  const renderLine = (index: number, inTable: boolean) => {
    const anchorProps = {
      "data-tmux-anchor-index": anchors ? index : undefined,
      "data-tmux-scroll-anchor": anchors ? "" : undefined
    };
    if (!parsed) {
      const line = inTable ? (lines[index] ?? "").trimEnd() : lines[index] ?? "";
      return (
        <span className="tmux-output-line" {...anchorProps} key={`${index}-${line}`}>
          <LinkifiedText text={line || "\u00a0"} />
        </span>
      );
    }
    const segments = inTable ? trimTrailingSpace(parsed[index] ?? []) : parsed[index] ?? [];
    const text = segments.map((segment) => segment.text).join("");
    return (
      <span className="tmux-output-line" {...anchorProps} key={`${index}-${text}`}>
        {text === "" ? "\u00a0" : segments.map((segment, segmentIndex) => {
          const style = ansiSegmentStyle(segment.style, theme);
          return style ? (
            <span key={segmentIndex} style={style}><LinkifiedText text={segment.text} /></span>
          ) : (
            <LinkifiedText key={segmentIndex} text={segment.text} />
          );
        })}
      </span>
    );
  };

  return blocks.map((block) => {
    const rows: ReactNode[] = [];
    for (let index = block.start; index < block.end; index += 1) {
      rows.push(renderLine(index, block.kind === "table"));
    }
    return block.kind === "table" ? (
      <TmuxOutputTable columns={block.columns} key={`table-${block.start}`}>{rows}</TmuxOutputTable>
    ) : rows;
  });
});

function TmuxOutputTable({ columns, children }: { columns: number; children: ReactNode }) {
  const frameRef = useRef<HTMLSpanElement | null>(null);
  const [metrics, setMetrics] = useState<TableMetrics | null>(null);
  const [scroll, setScroll] = useState({ start: true, end: false });

  useIsomorphicLayoutEffect(() => {
    const frame = frameRef.current;
    if (!frame) {
      return;
    }
    const update = () => {
      const next = measureTableFrame(frame);
      setMetrics((current) => (current && sameMetrics(current, next) ? current : next));
    };
    update();
    if (typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(update);
    observer.observe(frame);
    return () => observer.disconnect();
  }, []);

  const fit = metrics ? fitTmuxTable({ columns, ...metrics }) : null;
  const overflow = fit?.overflow ?? false;

  function handleScroll(event: UIEvent<HTMLSpanElement>) {
    const node = event.currentTarget;
    const start = node.scrollLeft <= 1;
    const end = node.scrollLeft + node.clientWidth >= node.scrollWidth - 1;
    setScroll((current) => (current.start === start && current.end === end ? current : { start, end }));
  }

  return (
    <span
      ref={frameRef}
      className="tmux-output-table"
      data-table-columns={columns}
      data-table-fit={fit?.mode}
      data-fade-left={overflow && !scroll.start ? "" : undefined}
      data-fade-right={overflow && !scroll.end ? "" : undefined}
    >
      <span
        className="tmux-output-table-scroll"
        onScroll={overflow ? handleScroll : undefined}
        style={fit?.mode === "scaled" ? { fontSize: `${fit.fontSize}px` } : undefined}
      >
        {children}
      </span>
    </span>
  );
}

// Reads layout only on mount and resize, never per capture refresh.
function measureTableFrame(frame: HTMLElement): TableMetrics {
  const style = window.getComputedStyle(frame);
  const baseFontSize = Number.parseFloat(style.fontSize) || 12;
  const key = `${style.fontFamily}|${baseFontSize}`;
  let charWidth = charWidthCache.get(key);
  if (charWidth === undefined) {
    const probe = document.createElement("span");
    probe.textContent = "0".repeat(100);
    probe.style.cssText = "position:absolute;visibility:hidden;white-space:pre;font:inherit;";
    frame.append(probe);
    charWidth = probe.getBoundingClientRect().width / 100 || baseFontSize * 0.6;
    probe.remove();
    charWidthCache.set(key, charWidth);
  }
  return { available: frame.clientWidth, charWidth, baseFontSize };
}

function sameMetrics(left: TableMetrics, right: TableMetrics): boolean {
  return left.available === right.available && left.charWidth === right.charWidth && left.baseFontSize === right.baseFontSize;
}

// Trailing blanks would widen the scroll area; keep them when they carry a background.
function trimTrailingSpace(segments: AnsiSegment[]): AnsiSegment[] {
  const trimmed = [...segments];
  while (trimmed.length > 0) {
    const last = trimmed[trimmed.length - 1] as AnsiSegment;
    if (last.style.bg || last.style.inverse) {
      break;
    }
    const text = last.text.trimEnd();
    if (text === last.text) {
      break;
    }
    if (text) {
      trimmed[trimmed.length - 1] = { ...last, text };
      break;
    }
    trimmed.pop();
  }
  return trimmed;
}
