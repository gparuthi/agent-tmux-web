import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { TmuxActionDto, TmuxActionsDto } from "../../shared/api.js";
import { TmuxActionsSheet } from "../TmuxActionsSheet.js";
import { formatTmuxActionResult, groupTmuxActions, tmuxActionConfirmSteps } from "../tmuxActions.js";

const handoff: TmuxActionDto = { name: "handoff session", desc: "hand over", kind: "builtin", group: "this pane" };
const yolo: TmuxActionDto = { name: "restart codex: yolo mode", desc: "no rails", kind: "builtin", group: "this pane", confirm: "restart codex with no approvals and no sandbox?" };
const layout: TmuxActionDto = { name: "next layout", desc: "cycle pane layouts", kind: "run", group: "recently used", recent: true };
const unkill: TmuxActionDto = { name: "unkill window", desc: "reopen the last closed window", kind: "run", group: "all" };

describe("tmux action helpers", () => {
  it("confirms builtins once and tpal's questions twice; plain runs go straight through", () => {
    expect(tmuxActionConfirmSteps(layout)).toEqual([]);
    expect(tmuxActionConfirmSteps(handoff)).toEqual(["confirm"]);
    expect(tmuxActionConfirmSteps(yolo)).toEqual(["confirm", "question"]);
  });

  it("groups actions in tpal's order", () => {
    expect(groupTmuxActions([handoff, yolo, layout, unkill]).map(({ group, actions }) => [group, actions.length])).toEqual([
      ["this pane", 2],
      ["recently used", 1],
      ["all", 1]
    ]);
    expect(groupTmuxActions([])).toEqual([]);
  });

  it("toasts tpal's output, or that the action finished", () => {
    expect(formatTmuxActionResult("next layout", "")).toBe("next layout: done");
    expect(formatTmuxActionResult("unkill window", "unkill: restored main:3\n")).toBe("unkill: restored main:3");
  });
});

describe("TmuxActionsSheet", () => {
  it("lists actions under tpal's groups with the pane header", () => {
    const listing: TmuxActionsDto = { target: "%3", header: "pane %3 · codex", actions: [handoff, yolo, layout, unkill] };
    const html = renderToStaticMarkup(
      <TmuxActionsSheet
        initialActions={listing}
        loadActions={vi.fn(() => new Promise<TmuxActionsDto>(() => undefined))}
        paneName="build agent"
        runAction={vi.fn()}
        onClose={vi.fn()}
        onResult={vi.fn()}
      />
    );
    expect(html).toContain('aria-label="Pane actions"');
    expect(html).toContain("pane %3 · codex");
    expect(html.indexOf(">this pane<")).toBeLessThan(html.indexOf(">recently used<"));
    expect(html.indexOf(">recently used<")).toBeLessThan(html.indexOf(">all<"));
    for (const action of [handoff, yolo, layout, unkill]) {
      expect(html).toContain(`<span class="pane-actions-name">${action.name}</span>`);
    }
  });

  it("shows a loading state before tpal answers", () => {
    const html = renderToStaticMarkup(
      <TmuxActionsSheet loadActions={vi.fn(() => new Promise<TmuxActionsDto>(() => undefined))} paneName="build agent" runAction={vi.fn()} onClose={vi.fn()} onResult={vi.fn()} />
    );
    expect(html).toContain("Loading…");
    expect(html).toContain("build agent");
  });
});
