import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { TmuxQueuedMessages } from "../TmuxQueuedMessages.js";

describe("TmuxQueuedMessages", () => {
  it("lists held messages oldest first with who they wait for and a cancel button each", () => {
    const html = renderToStaticMarkup(
      <TmuxQueuedMessages
        messages={[
          { id: "q1", text: "run the tests", agent: "hax", queuedAtMs: 1 },
          { id: "q2", text: "then commit", agent: "hax", queuedAtMs: 2 }
        ]}
        onCancel={vi.fn()}
      />
    );
    expect(html).toContain('aria-label="Queued messages"');
    expect(html.indexOf("run the tests")).toBeLessThan(html.indexOf("then commit"));
    expect(html.match(/Queued for hax · will send when it finishes/g)).toHaveLength(2);
    expect(html.match(/aria-label="Cancel queued message"/g)).toHaveLength(2);
  });

  it("renders nothing when nothing is held", () => {
    expect(renderToStaticMarkup(<TmuxQueuedMessages messages={[]} onCancel={vi.fn()} />)).toBe("");
  });
});
