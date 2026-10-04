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
});
