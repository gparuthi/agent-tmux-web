import type { TmuxActionDto } from "../shared/api.js";

export type TmuxActionConfirmStep = "confirm" | "question";

// Builtins restart or hand off the pane's agent, so they ask first; tpal's own question (yolo) asks again.
export function tmuxActionConfirmSteps(action: TmuxActionDto): TmuxActionConfirmStep[] {
  const steps: TmuxActionConfirmStep[] = [];
  if (action.kind === "builtin" || action.confirm) {
    steps.push("confirm");
  }
  if (action.confirm) {
    steps.push("question");
  }
  return steps;
}

// tpal's rank order, cut into its groups ("this pane", "recently used", "all").
export function groupTmuxActions(actions: TmuxActionDto[]): Array<{ group: string; actions: TmuxActionDto[] }> {
  const groups: Array<{ group: string; actions: TmuxActionDto[] }> = [];
  for (const action of actions) {
    const group = action.group ?? "";
    const last = groups[groups.length - 1];
    if (last && last.group === group) {
      last.actions.push(action);
    } else {
      groups.push({ group, actions: [action] });
    }
  }
  return groups;
}

export function formatTmuxActionResult(name: string, output: string): string {
  return output.trim() || `${name}: done`;
}
