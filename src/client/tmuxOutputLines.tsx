import { memo, useMemo } from "react";

import { ansiSegmentStyle, hasAnsi, parseAnsiLines } from "./ansi.js";
import { LinkifiedText } from "./LinkifiedText.js";
import type { ColorTheme } from "./theme.js";

type TmuxOutputLinesProps = { output: string; anchors?: boolean; theme?: ColorTheme };

export const TmuxOutputLines = memo(function TmuxOutputLines({ output, anchors = true, theme = "dark" }: TmuxOutputLinesProps) {
  const colored = hasAnsi(output);
  const parsed = useMemo(() => (colored ? parseAnsiLines(output) : null), [colored, output]);
  if (!parsed) {
    return output.split(/\r?\n/).map((line, index) => (
      <span
        className="tmux-output-line"
        data-tmux-anchor-index={anchors ? index : undefined}
        data-tmux-scroll-anchor={anchors ? "" : undefined}
        key={`${index}-${line}`}
      >
        <LinkifiedText text={line || " "} />
      </span>
    ));
  }
  return parsed.map((segments, index) => {
    const text = segments.map((segment) => segment.text).join("");
    return (
      <span
        className="tmux-output-line"
        data-tmux-anchor-index={anchors ? index : undefined}
        data-tmux-scroll-anchor={anchors ? "" : undefined}
        key={`${index}-${text}`}
      >
        {text === "" ? " " : segments.map((segment, segmentIndex) => {
          const style = ansiSegmentStyle(segment.style, theme);
          return style ? (
            <span key={segmentIndex} style={style}><LinkifiedText text={segment.text} /></span>
          ) : (
            <LinkifiedText key={segmentIndex} text={segment.text} />
          );
        })}
      </span>
    );
  });
});
