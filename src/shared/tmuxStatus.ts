import type { TmuxSessionStatusDto, TmuxSessionStatusKind } from "./api.js";
import { looksLikeTmuxDone, looksLikeTmuxWorking } from "./tmuxActivity.js";

export type TmuxStatusInput = {
  activityAtMs?: number | null;
  nowMs?: number;
  output?: string;
  runningActivityWindowMs?: number;
};

export const DEFAULT_RUNNING_ACTIVITY_WINDOW_MS = 5 * 60 * 1000;

export const TMUX_STATUS_TITLES: Record<TmuxSessionStatusKind, string> = {
  working: "Working",
  blocked: "Blocked",
  done: "Done",
  idle: "Idle",
  unknown: "Unknown"
};

const ANSI_PATTERN = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;
const OSC_PATTERN = /\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g;

// atw's own screen heuristics, the fallback when gpmon has no fresh row for a pane.
export function classifyTmuxStatus(input: TmuxStatusInput): TmuxSessionStatusDto {
  const output = input.output ?? "";
  const signalText = meaningfulSignalLines(output).slice(-12).join("\n");

  if (looksLikeTmuxWorking(output) && isActiveRecently(input)) {
    return tmuxStatus("working");
  }

  if (looksLikePermissionPrompt(signalText)) {
    return tmuxStatus("blocked", "Needs permission");
  }

  if (looksLikeQuestion(signalText)) {
    return tmuxStatus("blocked", "Asking a question");
  }

  if (looksLikeTmuxDone(output)) {
    return tmuxStatus("done");
  }

  return tmuxStatus("idle");
}

// A visible prompt on screen outranks the opencode harness; otherwise the harness knows better.
export function mergeTmuxSessionStatus(
  visibleStatus: TmuxSessionStatusDto,
  harnessStatus?: TmuxSessionStatusDto
): TmuxSessionStatusDto {
  if (!harnessStatus || visibleStatus.kind === "blocked") {
    return visibleStatus;
  }
  return harnessStatus;
}

// gpmon's fresh row wins; a bare "blocked" borrows the screen's reason when the screen agrees.
export function resolveTmuxSessionStatus(
  gpmonStatus: TmuxSessionStatusDto | undefined,
  visibleStatus: TmuxSessionStatusDto,
  harnessStatus?: TmuxSessionStatusDto
): TmuxSessionStatusDto {
  if (!gpmonStatus) {
    return mergeTmuxSessionStatus(visibleStatus, harnessStatus);
  }
  if (gpmonStatus.kind === "blocked" && visibleStatus.kind === "blocked") {
    return { ...gpmonStatus, title: visibleStatus.title };
  }
  return gpmonStatus;
}

export function tmuxStatus(kind: TmuxSessionStatusKind, title = TMUX_STATUS_TITLES[kind]): TmuxSessionStatusDto {
  return { kind, title, source: "atw" };
}

function isActiveRecently(input: TmuxStatusInput): boolean {
  if (typeof input.activityAtMs !== "number" || input.activityAtMs <= 0) {
    return true;
  }
  const nowMs = input.nowMs ?? Date.now();
  const windowMs = input.runningActivityWindowMs ?? DEFAULT_RUNNING_ACTIVITY_WINDOW_MS;
  return nowMs - input.activityAtMs <= windowMs;
}

function meaningfulSignalLines(output: string): string[] {
  return cleanText(output)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !isDecorativeLine(line) && !isLowSignalLine(line));
}

function cleanText(text: string): string {
  return text.replace(ANSI_PATTERN, "").replace(OSC_PATTERN, "");
}

function looksLikePermissionPrompt(text: string): boolean {
  return actionablePromptLines(text).some((line) => (
    /\b(allow|approve|permission|permissions|authorize|proceed|continue)\b/i.test(line)
    && /(\?|\[[yY]\/[nN]\]|press enter|\byes\b|\bno\b|esc to go back)/i.test(line)
  ));
}

function looksLikeQuestion(text: string): boolean {
  const lines = actionablePromptLines(text);
  const hasSelectedChoice = lines.some((line) => /^(?:(?:[>›❯]\s+)(?:\d+[.)]|[a-z][.)])|[●◉])\s+\S/i.test(line));
  const choiceLines = lines.filter((line) => /^(?:[>›❯]\s*)?(?:\d+[.)]|[a-z][.)]|[○●◉])\s+\S/i.test(line));
  const hasChoiceControlHint = /(?:press enter to confirm|enter to select|esc to go back|use (?:the )?(?:arrow|up|down) keys)/i.test(text);
  return hasSelectedChoice && choiceLines.length >= 2 && hasChoiceControlHint && !looksLikePermissionPrompt(text);
}

function actionablePromptLines(text: string): string[] {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  let latestReadyFooter = -1;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (/\bctrl\+p\s+commands\b/i.test(lines[index])) {
      latestReadyFooter = index;
      break;
    }
  }
  return lines.slice(latestReadyFooter + 1);
}

function isDecorativeLine(line: string): boolean {
  const compact = line.replace(/\s/g, "");
  return /^[╭╰├┤│─━═└┘┌┐┴┬┼-]{5,}$/.test(compact)
    || /^worked for \d/i.test(line)
    || /^gpt-[\w.-]+\s+/i.test(line);
}

function isLowSignalLine(line: string): boolean {
  return /^```/.test(line)
    || /^diff --git\b/.test(line)
    || /^index [0-9a-f]+\.\.[0-9a-f]+/.test(line)
    || /^@@\s/.test(line)
    || /^[+-]{3}\s/.test(line)
    || /^\d+\s+[+-]\s*/.test(line)
    || /^[+-]\s*(?:[{}()[\],;]|\.[\w-]+|#[\w-]+|(?:import|export|const|let|function|return|if|for|while|type|interface|class)\b)/.test(line)
    || /^[{}()[\],;]+$/.test(line)
    || /^\?\?\s+\S+/.test(line)
    || /^[ MADRCU]{1,2}\s+\S+/.test(line)
    || /(?:working|thinking|running).*?(?:interrupt|esc|ctrl-c)/i.test(line)
    || /(?:esc|ctrl-c)\s+to\s+interrupt/i.test(line)
    || /^(pnpm|npm|yarn|git|gh|curl|tmux|node|python|python3|pytest|systemctl|journalctl)\b/.test(line)
    || /^Test Files\b/.test(line)
    || /^Tests\b/.test(line)
    || /^\d+\s+(?:passed|failed|skipped)\b/i.test(line)
    || /^[│└├╰╭]/.test(line);
}
