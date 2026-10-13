import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { TmuxOutputLines } from "../tmuxOutputLines.js";

describe("TmuxOutputLines", () => {
  it("renders URLs as clickable links", () => {
    const html = renderToStaticMarkup(<pre><TmuxOutputLines output="Open https://example.com/docs." /></pre>);
    expect(html).toContain("<a href=\"https://example.com/docs\"");
    expect(html).toContain("target=\"_blank\"");
    expect(html).toContain("rel=\"noreferrer noopener\"");
  });

  it("keeps scroll anchors on stream lines and omits them from details", () => {
    const stream = renderToStaticMarkup(<pre><TmuxOutputLines output={"first\nsecond"} /></pre>);
    const details = renderToStaticMarkup(<pre><TmuxOutputLines anchors={false} output="Context" /></pre>);
    expect(stream).toContain("data-tmux-anchor-index=\"0\"");
    expect(stream).toContain("data-tmux-anchor-index=\"1\"");
    expect(details).not.toContain("data-tmux-anchor-index");
    expect(details).not.toContain("data-tmux-scroll-anchor");
  });

  it("renders ANSI colours as styled spans without leaking escape bytes", () => {
    const output = "\u001b[31mred\u001b[0m see https://example.com/x\n\n\u001b[38;5;231mwhite";
    const dark = renderToStaticMarkup(<pre><TmuxOutputLines output={output} theme="dark" /></pre>);
    const light = renderToStaticMarkup(<pre><TmuxOutputLines output={output} theme="light" /></pre>);
    expect(dark).toContain("<span style=\"color:#ff6b6b\">red</span>");
    expect(dark).toContain("<a href=\"https://example.com/x\"");
    expect(dark).toContain("color:rgb(255, 255, 255)");
    expect(light).toContain("<span style=\"color:#c0262d\">red</span>");
    expect(light).not.toContain("color:rgb(255, 255, 255)");
    expect(dark).not.toContain("\u001b");
    expect(dark).toContain("data-tmux-anchor-index=\"2\"");
    expect(dark).toContain("\u00a0");
  });

  it("wraps box tables in a scroll container and leaves prose lines outside it", () => {
    const output = [
      "Prose before \u2502 the table.",
      "  \u250c\u2500\u2500\u2500\u2500\u2500\u2500\u252c\u2500\u2500\u2500\u2500\u2500\u2500\u2510   ",
      "  \u2502 a    \u2502 b    \u2502",
      "  \u2514\u2500\u2500\u2500\u2500\u2500\u2500\u2534\u2500\u2500\u2500\u2500\u2500\u2500\u2518",
      "Prose after."
    ].join("\n");
    const html = renderToStaticMarkup(<pre><TmuxOutputLines output={output} /></pre>);
    const tableStart = html.indexOf("<span class=\"tmux-output-table\"");
    const tableEnd = html.indexOf("data-tmux-anchor-index=\"4\"");
    expect(tableStart).toBeGreaterThan(html.indexOf("Prose before"));
    expect(tableEnd).toBeGreaterThan(tableStart);
    expect(html).toContain("data-table-columns=\"17\"");
    expect(html).toContain("<span class=\"tmux-output-table-scroll\">");
    expect(html.match(/class="tmux-output-table"/g)).toHaveLength(1);
    const table = html.slice(tableStart, tableEnd);
    expect(table).toContain("data-tmux-anchor-index=\"1\"");
    expect(table).toContain("data-tmux-anchor-index=\"3\"");
    expect(html.slice(tableEnd)).toContain("Prose after.");
    expect(table).toContain("\u250c\u2500\u2500\u2500\u2500\u2500\u2500\u252c\u2500\u2500\u2500\u2500\u2500\u2500\u2510<");
  });

  it("keeps ANSI styles on table rows and trims only unstyled trailing blanks", () => {
    const output = [
      "\u250c\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u252c\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2510",
      "\u2502 \u001b[1mCheck\u001b[0m  \u2502 Count \u2502   ",
      "\u2502 \u001b[32mtests\u001b[0m  \u2502 \u001b[44m812   \u001b[0m\u2502",
      "\u2514\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2534\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2518"
    ].join("\n");
    const html = renderToStaticMarkup(<pre><TmuxOutputLines output={output} theme="dark" /></pre>);
    expect(html).toContain("class=\"tmux-output-table\"");
    expect(html).toContain("<span style=\"font-weight:650\">Check</span>");
    expect(html).toContain("<span style=\"color:#7bd88f\">tests</span>");
    expect(html).toContain("812   </span>");
    expect(html).toContain("Count \u2502</span>");
    expect(html).not.toContain("\u001b");
  });

  it("renders a coloured Claude prompt-frame rule as one line keeping its label and anchor", () => {
    const grey = "\u001b[38;2;136;136;136m";
    const output = [
      "  \u23bf  Tip: Use git worktrees.",
      `${grey}${"\u2500".repeat(174)} \u001b[1matw\u001b[22m \u2500\u001b[0m`,
      "\u276f ",
      `${grey}${"\u2500".repeat(180)}\u001b[0m`
    ].join("\n");
    const html = renderToStaticMarkup(<pre><TmuxOutputLines output={output} theme="dark" /></pre>);
    expect(html.match(/class="tmux-output-line tmux-output-rule"/g)).toHaveLength(2);
    expect(html).not.toContain("\u2500".repeat(4));
    expect(html).toContain("data-rule-align=\"right\"");
    expect(html).toContain("--tmux-rule-color:rgb(136, 136, 136)");
    expect(html).toContain("<span class=\"tmux-output-rule-label\"><span style=\"color:rgb(136, 136, 136);font-weight:650\">atw</span></span>");
    expect(html).toContain("<span class=\"tmux-output-rule-stub\">\u2500\u2500\u2500</span>");
    expect(html).toContain("data-tmux-anchor-index=\"1\"");
    expect(html).toContain("data-tmux-anchor-index=\"3\"");
    expect(html).toContain("\u276f");
    expect(html).toContain("Tip: Use git worktrees.");
  });

  it("renders a plain rule without ANSI and leaves short dashes as text", () => {
    const html = renderToStaticMarkup(<pre><TmuxOutputLines output={`a -- b\n---\n${"-".repeat(60)} end ---`} /></pre>);
    expect(html.match(/tmux-output-rule"/g)).toHaveLength(1);
    expect(html).toContain("data-rule-align=\"right\"");
    expect(html).toContain("<span class=\"tmux-output-rule-label\">end</span>");
    expect(html).toContain(">a -- b<");
    expect(html).toContain(">---<");
    expect(html).not.toContain("--tmux-rule-color");
  });
});
