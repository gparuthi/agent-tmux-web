import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal as XtermTerminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import {
  Activity,
  AlarmClock,
  ArrowDown,
  ArrowDownToLine,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Bell,
  BellOff,
  Bot,
  Check,
  CircleStop,
  CornerDownLeft,
  Copy,
  Cpu,
  Ellipsis,
  Eye,
  EyeOff,
  Folder,
  Keyboard,
  Menu,
  Monitor,
  Moon,
  Paperclip,
  Pin,
  Play,
  Plus,
  RefreshCw,
  Send,
  Sparkles,
  SquareX,
  Sun,
  Terminal as TerminalIcon,
  Wrench
} from "lucide-react";
import { ClipboardEvent, FormEvent, KeyboardEvent, UIEvent, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import {
  TMUX_CAPTURE_HISTORY_LINES,
  type AgentsDto,
  type AppStatus,
  type CodexModel,
  type CodexSkill,
  type StartAgentResultDto,
  type TmuxCaptureDto,
  type TmuxSessionDto,
  type TmuxWatchEvent,
  type UploadedFileDto
} from "../shared/api.js";
import { describeThreadItem, type UiEventDescription } from "../shared/codexEvents.js";
import {
  filterSlashCommands,
  parseSlashCommand,
  replaceSlashQuery,
  slashQueryForMessage,
  type SlashCommand
} from "./slashCommands.js";
import { COLOR_THEME_STORAGE_KEY, resolveInitialColorTheme, type ColorTheme } from "./theme.js";
import { dropAccessTokenFromAddressBar, readAccessToken } from "./accessToken.js";
import { writeClipboardText } from "./clipboard.js";
import { applyTextareaPaste, buildPastedPromptText, extractPastedImageFiles, formatUploadedFilesForPrompt, isMobileInputDevice, readClipboardImageFiles, readInputDeviceContext, shouldSubmitTextareaEnter } from "./inputBehavior.js";
import { LinkifiedText } from "./LinkifiedText.js";
import { openRawTerminalLink } from "./rawTerminalLinks.js";
import {
  rawTerminalExtendedKeySequence,
  shouldFocusRawTerminalTap,
  shouldProcessRawTerminalKeyEvent,
  shouldShowRawTerminalShortcuts,
  shouldShowTmuxJumpToLatest,
  shouldShowTmuxSendForm
} from "./rawTerminalMode.js";
import { installRawTerminalGestureGuard } from "./rawTerminalGestureGuard.js";
import { installRawTerminalInputGuard } from "./rawTerminalInputGuard.js";
import { createRawTerminalSelectionHandler } from "./rawTerminalSelection.js";
import { shouldAutoCaptureTmux, TMUX_CAPTURE_POLL_INTERVAL_MS, TMUX_SEND_FOLLOW_DELAYS_MS } from "./tmuxFollow.js";
import {
  isCurrentTmuxCaptureOwner,
  shouldAdmitTmuxCapture,
  shouldApplyTmuxCapture,
  shouldApplyTmuxPrefetch,
  type TmuxCaptureSource
} from "./tmuxOperationGuards.js";
import { buildTmuxTransitionNotification } from "./tmuxNotifications.js";
import {
  defaultTmuxPaneSelection,
  findTmuxPane,
  formatTmuxStatusText,
  normalizeRequestedTmuxSession,
  parsePinnedTmuxSessionNames,
  PINNED_TMUX_SESSIONS_STORAGE_KEY,
  readRequestedTmuxSession,
  removeRequestedTmuxSession,
  tmuxPaneDisplayName,
  tmuxPaneShortName,
  togglePinnedTmuxSessionName
} from "./tmuxSessionTarget.js";
import {
  filterTmuxAgentPanes,
  markTmuxPanesViewed,
  nextTmuxRailPaneAfter,
  parseTmuxPaneViews,
  parseTmuxSessionGroupPreferences,
  setTmuxSessionGroupCollapsed,
  SHOW_ALL_TMUX_PANES_STORAGE_KEY,
  TMUX_PANE_VIEWS_STORAGE_KEY,
  TMUX_SESSION_GROUPS_STORAGE_KEY,
  tmuxWindowPaneNames,
  visibleTmuxRailPanes,
  type TmuxPaneViews,
  type TmuxSessionGroupPreferences
} from "./tmuxSessionGroups.js";
import { TmuxSessionList } from "./TmuxSessionList.js";
import {
  insertedCharacter,
  isRawTypedCharacter,
  rawKeyBytes,
  tmuxKeyName,
  toggleKeyStripModifier,
  typedKeyFromBeforeInput,
  typedKeyFromKeyDown,
  type KeyStripKey,
  type KeyStripModifier
} from "./keyStripCombos.js";
import { TmuxKeyStrip } from "./TmuxKeyStrip.js";
import { NewAgentSheet } from "./NewAgentSheet.js";
import { WindowSnoozeSheet } from "./WindowSnoozeSheet.js";
import { TmuxTtyView } from "./TmuxTtyView.js";
import {
  DEFAULT_TMUX_VIEW_STORAGE_KEY,
  FALLBACK_TMUX_VIEW_MODE,
  FALLBACK_TMUX_VIEW_SWITCH_POLICY,
  normalizeTmuxViewMode,
  normalizeTmuxViewSwitchPolicy,
  parseTmuxSessionViewModes,
  resolveTmuxViewMode,
  TMUX_SESSION_VIEWS_STORAGE_KEY,
  TMUX_VIEW_SWITCH_POLICY_STORAGE_KEY,
  type TmuxViewMode,
  type TmuxViewSwitchPolicy
} from "./tmuxViewPreferences.js";
import { canShowBrowserNotifications, canShowWebSocketTaskNotifications, getBrowserNotificationAvailability, getBrowserNotificationSnapshot, setAndroidWatchPollingEnabled, showAgentNotification } from "./browserNotifications.js";
import { hasAndroidConnectionSettings, openAndroidConnectionSettings } from "./androidConnectionSettings.js";

type TimelineEntry = {
  id: string;
  kind: string;
  title: string;
  body: string;
  status?: string;
};

type ThreadSummary = {
  id: string;
  preview: string;
  name: string | null;
  cwd: string;
  status: string;
  updatedAt: number;
};

type TmuxCaptureOptions = {
  owner?: number;
  signal?: AbortSignal;
  source: TmuxCaptureSource;
};

type CachedTmuxCapture = Pick<TmuxCaptureDto, "output" | "outputRevision" | "sidebar">;

const TMUX_VIEW_MODE_LABELS: Record<TmuxViewMode, string> = {
  tty: "TTY",
  raw: "Raw"
};

type WsPayload = {
  type: string;
  status?: AppStatus | Partial<AppStatus["codex"]>;
  recentEvents?: WsPayload[];
  description?: UiEventDescription;
  notification?: unknown;
  event?: TmuxWatchEvent;
};

type TmuxScrollSnapshot = {
  anchorIndex: number;
  anchorOffsetTop: number;
  anchorText: string;
  scrollTop: number;
};

const defaultCwd = "";
const TMUX_TERMINAL_SUBMIT_DELAY_MS = 350;
const TMUX_MANUAL_CAPTURE_TIMEOUT_MS = 15_000;
const RAW_TERMINAL_INPUT_CHUNK_SIZE = 16_000;
const TMUX_NOTIFICATION_STORAGE_KEY = "agent-tmux-web.notify";
const TMUX_SESSION_STATUS_POLL_INTERVAL_MS = 3_000;
const TMUX_SCROLL_ANCHOR_SELECTOR = "[data-tmux-scroll-anchor]";
const BROWSER_CLIENT_ID = globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
const demoMode = typeof window !== "undefined" && new URLSearchParams(window.location.search).has("demo");
// Read once so API and socket auth survive dropping the token from the address bar.
const initialAccessToken = typeof window === "undefined" ? "" : readAccessToken(window.location.search);
const DEMO_STATUS: AppStatus = {
  environment: "production",
  bindHost: "127.0.0.1",
  port: 6174,
  defaultCwd: "/workspace/project",
  tailscaleIp: "100.x.y.z",
  tailscaleDns: "agent-server.tailnet.example",
  windowSnooze: false,
  codex: {
    connected: false,
    appServerUrl: "ws://127.0.0.1:43117",
    initialized: false,
    lastError: null
  }
};
const DEMO_TMUX_SESSIONS: TmuxSessionDto[] = [
  { name: "agent-demo", currentCommand: "codex", windows: 1, created: "Thu May 14 09:00:00 2026", attached: true, viewerCount: 1, status: { kind: "working", title: "Working" } },
  { name: "release-notes", currentCommand: "claude", windows: 1, created: "Thu May 14 09:10:00 2026", attached: false, viewerCount: 0, status: { kind: "idle", title: "Idle" } },
  { name: "infra-check", currentCommand: "opencode", windows: 2, created: "Thu May 14 09:20:00 2026", attached: false, viewerCount: 0, status: { kind: "blocked", title: "Needs permission" } }
];
const DEMO_TMUX_OUTPUT = [
  "› Review the mobile release checklist and prep the launch notes.",
  "",
  "• Mobile layout checked at 390px wide.",
  "• Tmux sessions keep running on the server while the browser stays lightweight.",
  "• Eleven built-in coding harnesses and custom CLI commands can launch from the same menu.",
  "• Refresh updates the session list and current view without stealing your scroll position.",
  "• Documentation stays clickable at https://example.com/docs.",
  "",
  "```terminal",
  "pnpm test",
  "full test suite passed",
  "pnpm build",
  "production bundle ready",
  "pnpm android:build:public",
  "public APK verified: no embedded URL or token",
  "```",
  "",
  "› Attach docs/release-plan.md and summarize next steps.",
  "",
  "• Uploaded files use safe ~/.agent-tmux/attachments/... references; temporary storage stays internal.",
  "• Auto-capture can read a deeper tmux history so older context stays reachable.",
  "• When you scroll up, new output waits quietly until you jump back to latest.",
  "",
  "```terminal",
  "tmux capture-pane -p -S -5000",
  "history captured without attaching",
  "```",
  "",
  "› Open raw tmux for a stuck TUI and send Ctrl-C.",
  "",
  "• Raw tmux mode keeps native arrow keys, Ctrl-C, and exact TUI behavior available.",
  "• Detach returns to the same long-lived session.",
  "",
  "Working (2m 14s • esc to interrupt)",
  "",
  "  agent demo · ~/workspace/project"
].join("\n");
const DEMO_TMUX_SIDEBAR: NonNullable<TmuxCaptureDto["sidebar"]> = {
  kind: "opencode",
  output: [
    "Mobile release and documentation",
    "",
    "Context",
    "25,467 tokens",
    "18% used",
    "$0.00 spent",
    "",
    "MCP",
    "• github Connected",
    "• playwright Connected",
    "",
    "LSP",
    "TypeScript Ready",
    "",
    "Todo",
    "[•] Verify release assets",
    "[ ] Publish v0.1.26",
    "",
    "~/workspace/project",
    "• OpenCode 1.18.3"
  ].join("\n")
};
const DEMO_RAW_TERMINAL_OUTPUT = [
  "$ tmux attach -t agent-demo",
  "agent-demo:0.0  390x844  raw browser terminal",
  "",
  "$ claude",
  "",
  "Claude Code  /workspace/project",
  "> /status",
  "connected: tmux session agent-demo",
  "keys: Esc Tab Ctrl-C Ctrl-D Ctrl-L arrows Enter",
  "",
  "> Review mobile captures and README",
  "Working... use Ctrl-C to stop or detach to keep it running.",
  "",
  "docs: https://example.com/docs",
  "",
  "agent-demo $"
].join("\n");

function resizeTmuxInput(node: HTMLTextAreaElement | null) {
  if (!node) {
    return;
  }

  node.style.height = "0px";
  const maxHeight = 112;
  const nextHeight = Math.min(Math.max(node.scrollHeight, 38), maxHeight);
  node.style.height = `${nextHeight}px`;
  node.style.overflowY = node.scrollHeight > maxHeight ? "auto" : "hidden";
  if (node.selectionEnd >= node.value.length - 1) {
    node.scrollTop = node.scrollHeight;
  }
}

export function App() {
  const [status, setStatus] = useState<AppStatus | null>(demoMode ? DEMO_STATUS : null);
  const [models, setModels] = useState<CodexModel[]>([]);
  const [skills, setSkills] = useState<CodexSkill[]>([]);
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [tmuxSessions, setTmuxSessions] = useState<TmuxSessionDto[]>(demoMode ? DEMO_TMUX_SESSIONS : []);
  const [selectedTmux, setSelectedTmux] = useState(demoMode ? "agent-demo" : "");
  const [tmuxOutput, setTmuxOutput] = useState(demoMode ? DEMO_TMUX_OUTPUT : "");
  const [tmuxSidebar, setTmuxSidebar] = useState<TmuxCaptureDto["sidebar"]>(demoMode ? DEMO_TMUX_SIDEBAR : undefined);
  const [tmuxInput, setTmuxInput] = useState(demoMode ? "Check the mobile layout and summarize risks" : "");
  const [threadId, setThreadId] = useState("");
  const [activeTurnId, setActiveTurnId] = useState("");
  const [threadStatus, setThreadStatus] = useState("idle");
  const [model, setModel] = useState("gpt-5.5");
  const [effort, setEffort] = useState("xhigh");
  const [cwd, setCwd] = useState(demoMode ? DEMO_STATUS.defaultCwd : defaultCwd);
  const [message, setMessage] = useState("");
  const [composerCaret, setComposerCaret] = useState(0);
  const [skillQuery, setSkillQuery] = useState("");
  const [timeline, setTimeline] = useState<TimelineEntry[]>([]);
  const [error, setError] = useState("");
  const [newAgentOpen, setNewAgentOpen] = useState(false);
  const [windowSnoozeTarget, setWindowSnoozeTarget] = useState("");
  const [pinnedTmuxSessionNames, setPinnedTmuxSessionNames] = useState<string[]>(readInitialPinnedTmuxSessionNames);
  const [tmuxSessionGroupPreferences, setTmuxSessionGroupPreferences] = useState<TmuxSessionGroupPreferences>(readInitialTmuxSessionGroupPreferences);
  const [tmuxPaneViews, setTmuxPaneViews] = useState<TmuxPaneViews>(readInitialTmuxPaneViews);
  const [showAllTmuxPanes, setShowAllTmuxPanes] = useState(readInitialShowAllTmuxPanes);
  const [slashIndex, setSlashIndex] = useState(0);
  const [tmuxViewMode, setTmuxViewModeState] = useState(readInitialDefaultTmuxViewMode);
  const terminalActive = tmuxViewMode === "raw";
  const [rawTerminalConnectionId, setRawTerminalConnectionId] = useState(0);
  const [tmuxMenuOpen, setTmuxMenuOpen] = useState(false);
  const [tmuxNotificationsEnabled, setTmuxNotificationsEnabled] = useState(readTmuxNotificationPreference);
  const [colorTheme, setColorTheme] = useState(readInitialColorTheme);
  const [defaultTmuxViewMode, setDefaultTmuxViewMode] = useState(readInitialDefaultTmuxViewMode);
  const [tmuxViewSwitchPolicy, setTmuxViewSwitchPolicy] = useState(readInitialTmuxViewSwitchPolicy);
  const [tmuxSessionViewModes, setTmuxSessionViewModes] = useState(readInitialTmuxSessionViewModes);
  const [requestedTmuxSession, setRequestedTmuxSession] = useState(readInitialRequestedTmuxSession);
  const [tmuxAtBottom, setTmuxAtBottom] = useState(true);
  const [uploadingComposerFiles, setUploadingComposerFiles] = useState(false);
  const [uploadingTmuxFiles, setUploadingTmuxFiles] = useState(false);
  const [terminalStatus, setTerminalStatus] = useState(demoMode ? `${TMUX_VIEW_MODE_LABELS[readInitialDefaultTmuxViewMode()].toLowerCase()} view for agent-demo` : "");
  const [manualCaptureActive, setManualCaptureActive] = useState(false);
  const [armedKeyModifier, setArmedKeyModifierState] = useState<KeyStripModifier | null>(null);
  const armedKeyModifierRef = useRef<KeyStripModifier | null>(null);
  const consumeArmedKeyRef = useRef<(typed: string) => boolean>(() => false);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const terminalHostRef = useRef<HTMLDivElement | null>(null);
  const rawTerminalRef = useRef<XtermTerminal | null>(null);
  const terminalSocketRef = useRef<WebSocket | null>(null);
  const terminalSessionRef = useRef("");
  const tmuxInputRef = useRef<HTMLTextAreaElement | null>(null);
  const tmuxFileInputRef = useRef<HTMLInputElement | null>(null);
  const tmuxOutputRef = useRef<HTMLElement | null>(null);
  const tmuxCaptureWidthRef = useRef<HTMLDivElement | null>(null);
  const tmuxSettingsMenuRef = useRef<HTMLDetailsElement | null>(null);
  const tmuxFollowTimersRef = useRef<number[]>([]);
  const manualCaptureControllerRef = useRef<AbortController | null>(null);
  const manualCaptureOwnerRef = useRef<number | null>(null);
  const manualCaptureOwnerSequenceRef = useRef(0);
  const manualCaptureTimeoutRef = useRef<number | null>(null);
  const tmuxNotificationsEnabledRef = useRef(tmuxNotificationsEnabled);
  const tmuxNotificationCursorRef = useRef<number | null>(null);
  const pendingTmuxNotificationEventsRef = useRef<TmuxWatchEvent[]>([]);
  const tmuxStickToBottomRef = useRef(true);
  const forceTmuxScrollBottomRef = useRef(false);
  const tmuxScrollSnapshotRef = useRef<TmuxScrollSnapshot | null>(null);
  const selectedTmuxRef = useRef(selectedTmux);
  const tmuxSessionsRef = useRef(tmuxSessions);
  tmuxSessionsRef.current = tmuxSessions;
  const tmuxViewModeRef = useRef(tmuxViewMode);
  const terminalActiveRef = useRef(terminalActive);
  const tmuxCaptureRequestIdRef = useRef(0);
  const initialTmuxViewAppliedRef = useRef(false);
  const tmuxCaptureCacheRef = useRef<Record<string, CachedTmuxCapture>>({});
  const tmuxAutomaticCaptureInFlightRef = useRef(new Set<string>());
  const tmuxCapturePrefetchRef = useRef(new Set<string>());
  const tmuxViewEpochRef = useRef(0);
  const androidConnectionSettingsAvailable = hasAndroidConnectionSettings();

  const modelEfforts = useMemo(() => {
    const found = models.find((entry) => entry.id === model || entry.model === model);
    return found?.supportedReasoningEfforts.map((entry) => entry.reasoningEffort) ?? ["low", "medium", "high", "xhigh"];
  }, [model, models]);

  const filteredSkills = useMemo(() => {
    const query = skillQuery.trim().toLowerCase();
    return skills
      .filter((skill) => !query || `${skill.name} ${skill.description}`.toLowerCase().includes(query))
      .slice(0, 8);
  }, [skillQuery, skills]);

  const slashQuery = useMemo(() => slashQueryForMessage(message, composerCaret), [composerCaret, message]);
  const slashMatches = useMemo(() => slashQuery ? filterSlashCommands(slashQuery.query) : [], [slashQuery]);
  const sessionSelected = Boolean(selectedTmux);
  const showTmuxSendForm = shouldShowTmuxSendForm({ terminalActive, sessionSelected });
  const showTmuxJumpToLatest = shouldShowTmuxJumpToLatest({ terminalActive, sessionSelected, tmuxAtBottom });
  const mobileRawInput = (typeof window !== "undefined" && Boolean(window.AgentTmuxAndroid))
    || isMobileInputDevice(readInputDeviceContext());
  const showRawTerminalShortcuts = shouldShowRawTerminalShortcuts({
    terminalActive,
    mobileInput: mobileRawInput,
    sessionSelected
  });
  // Same strip under the input box on phones, where the soft keyboard has no Esc/Ctrl/arrows.
  const showTmuxKeyStrip = showRawTerminalShortcuts || (showTmuxSendForm && mobileRawInput);
  const tmuxViewModeLabel = TMUX_VIEW_MODE_LABELS[tmuxViewMode];
  const selectedTmuxEntry = useMemo(() => findTmuxPane(tmuxSessions, selectedTmux), [selectedTmux, tmuxSessions]);
  const railTmuxPanes = useMemo(
    () => filterTmuxAgentPanes(tmuxSessions, showAllTmuxPanes, selectedTmux),
    [selectedTmux, showAllTmuxPanes, tmuxSessions]
  );
  const hiddenTmuxPaneCount = tmuxSessions.length - railTmuxPanes.length;
  const selectedTmuxPinned = Boolean(selectedTmux) && pinnedTmuxSessionNames.includes(selectedTmux);
  // tmux-hide-window runs against this host's tmux, so container (shim-prefixed) panes can't snooze.
  const windowSnoozeAvailable = !demoMode && Boolean(status?.windowSnooze);
  const selectedTmuxSnoozable = windowSnoozeAvailable && Boolean(selectedTmuxEntry?.paneId) && selectedTmuxEntry?.name === selectedTmuxEntry?.paneId;
  const windowSnoozeEntry = windowSnoozeTarget ? findTmuxPane(tmuxSessions, windowSnoozeTarget) : undefined;

  const baseUrl = useMemo(() => {
    if (!status) {
      return "";
    }
    const host = status.tailscaleDns ?? status.tailscaleIp ?? status.bindHost;
    return `http://${host}:${status.port}`;
  }, [status]);

  const loadStatus = useCallback(async () => {
    if (demoMode) {
      setStatus(DEMO_STATUS);
      setCwd(DEMO_STATUS.defaultCwd);
      return;
    }
    const nextStatus = await api<AppStatus>("/api/status");
    setStatus(nextStatus);
    setCwd((current) => current || nextStatus.defaultCwd);
  }, []);

  const loadModels = useCallback(async () => {
    const result = await api<{ data: CodexModel[] }>("/api/models");
    setModels(result.data);
    const preferred = result.data.find((entry) => entry.isDefault) ?? result.data[0];
    if (preferred) {
      setModel(preferred.id);
      const efforts = preferred.supportedReasoningEfforts.map((entry) => entry.reasoningEffort);
      setEffort(efforts.includes("xhigh") ? "xhigh" : preferred.defaultReasoningEffort || "high");
    }
  }, []);

  const loadSkills = useCallback(async () => {
    const result = await api<{ data: Array<{ skills: CodexSkill[] }> }>(`/api/skills?cwd=${encodeURIComponent(cwd)}`);
    setSkills(result.data.flatMap((entry) => entry.skills).filter((skill) => skill.enabled));
  }, [cwd]);

  const loadThreads = useCallback(async () => {
    const result = await api<{ data: ThreadSummary[] }>("/api/threads");
    setThreads(result.data);
  }, []);

  const loadTmuxSessions = useCallback(async () => {
    if (demoMode) {
      setTmuxSessions(DEMO_TMUX_SESSIONS);
      setSelectedTmux((current) => current || DEMO_TMUX_SESSIONS[0]?.name || "");
      return;
    }
    const result = await api<{ data: TmuxSessionDto[] }>(`/api/tmux/sessions?clientId=${encodeURIComponent(BROWSER_CLIENT_ID)}`);
    setTmuxSessions(result.data);
    setSelectedTmux((current) => current || defaultTmuxPaneSelection(result.data));
  }, []);

  const captureTmux = useCallback(async (session: string, options: TmuxCaptureOptions): Promise<boolean> => {
    const captureIsAdmitted = () => shouldAdmitTmuxCapture({
      activeManualOwner: manualCaptureOwnerRef.current,
      owner: options.owner,
      session,
      source: options.source,
      terminalActive: terminalActiveRef.current
    });
    if (!captureIsAdmitted()) {
      return false;
    }
    const automatic = options.source !== "manual";
    if (automatic && tmuxAutomaticCaptureInFlightRef.current.has(session)) {
      return false;
    }
    if (automatic) {
      tmuxAutomaticCaptureInFlightRef.current.add(session);
    }
    try {
      const requestId = ++tmuxCaptureRequestIdRef.current;
      if (demoMode) {
        const applied = captureIsAdmitted() && shouldApplyTmuxCapture({
          requestId,
          latestRequestId: tmuxCaptureRequestIdRef.current,
          targetSession: session,
          selectedSession: selectedTmuxRef.current,
          terminalActive: terminalActiveRef.current
        });
        if (!applied) {
          return false;
        }
        tmuxCaptureCacheRef.current[session] = {
          output: DEMO_TMUX_OUTPUT,
          sidebar: DEMO_TMUX_SIDEBAR
        };
        setCapturedTmuxOutput(DEMO_TMUX_OUTPUT, DEMO_TMUX_SIDEBAR);
        return true;
      }
      const params = new URLSearchParams({
        session,
        lines: String(TMUX_CAPTURE_HISTORY_LINES),
        clientWidth: String(resolveTmuxCaptureClientWidth()),
        clientHeight: String(resolveTmuxCaptureClientHeight()),
        resize: "true",
        ansi: "true"
      });
      const previousCapture = tmuxCaptureCacheRef.current[session];
      if (previousCapture?.outputRevision) {
        params.set("outputRevision", previousCapture.outputRevision);
      }
      const result = await api<TmuxCaptureDto>(`/api/tmux/capture?${params.toString()}`, {
        signal: options.signal
      });
      const applied = captureIsAdmitted() && shouldApplyTmuxCapture({
        requestId,
        latestRequestId: tmuxCaptureRequestIdRef.current,
        targetSession: session,
        selectedSession: selectedTmuxRef.current,
        terminalActive: terminalActiveRef.current
      });
      if (!applied) {
        return false;
      }
      const nextCapture = resolveTmuxCapture(result, previousCapture);
      tmuxCaptureCacheRef.current[session] = nextCapture;
      if (!sameTmuxCaptureContent(previousCapture, nextCapture)) {
        setCapturedTmuxOutput(nextCapture.output, nextCapture.sidebar);
      }
      return true;
    } finally {
      if (automatic) {
        tmuxAutomaticCaptureInFlightRef.current.delete(session);
      }
    }
  }, []);

  const prefetchTmuxCapture = useCallback(async (session: string): Promise<void> => {
    if (!session || tmuxCapturePrefetchRef.current.has(session)) {
      return;
    }
    if (demoMode) {
      tmuxCaptureCacheRef.current[session] = {
        output: DEMO_TMUX_OUTPUT,
        sidebar: DEMO_TMUX_SIDEBAR
      };
      return;
    }
    const viewEpoch = tmuxViewEpochRef.current;
    tmuxCapturePrefetchRef.current.add(session);
    try {
      const params = new URLSearchParams({
        session,
        lines: String(TMUX_CAPTURE_HISTORY_LINES),
        clientWidth: String(resolveTmuxCaptureClientWidth()),
        clientHeight: String(resolveTmuxCaptureClientHeight()),
        resize: "false",
        ansi: "true"
      });
      const previousCapture = tmuxCaptureCacheRef.current[session];
      if (previousCapture?.outputRevision) {
        params.set("outputRevision", previousCapture.outputRevision);
      }
      const result = await api<TmuxCaptureDto>(`/api/tmux/capture?${params.toString()}`);
      if (!shouldApplyTmuxPrefetch({
        currentEpoch: tmuxViewEpochRef.current,
        requestEpoch: viewEpoch,
        selectedSession: selectedTmuxRef.current,
        targetSession: session,
        terminalActive: terminalActiveRef.current
      })) {
        return;
      }
      tmuxCaptureCacheRef.current[session] = resolveTmuxCapture(result, previousCapture);
    } finally {
      tmuxCapturePrefetchRef.current.delete(session);
    }
  }, []);

  useEffect(() => {
    selectedTmuxRef.current = selectedTmux;
  }, [selectedTmux]);

  // Arriving at or leaving a pane marks its output seen, so the rail dims it like tmux's activity flag.
  const viewedTmuxPaneRef = useRef("");
  useEffect(() => {
    const previous = viewedTmuxPaneRef.current;
    viewedTmuxPaneRef.current = selectedTmux;
    const entries = tmuxSessionsRef.current;
    const names = [...new Set([...tmuxWindowPaneNames(entries, previous), ...tmuxWindowPaneNames(entries, selectedTmux)])];
    if (names.length === 0) {
      return;
    }
    // Server timestamps can run ahead of a phone's clock; never record a view older than the output it saw.
    const latestActivityAtMs = Math.max(0, ...entries.filter((entry) => names.includes(entry.name)).map((entry) => entry.activityAtMs ?? 0));
    setTmuxPaneViews((current) => {
      const next = markTmuxPanesViewed(current, names, Math.max(Date.now(), latestActivityAtMs));
      writeStoredJson(TMUX_PANE_VIEWS_STORAGE_KEY, next);
      return next;
    });
  }, [selectedTmux]);

  // iOS soft keyboards report "Unidentified" keydowns, so an armed modifier also intercepts beforeinput.
  useEffect(() => {
    const input = tmuxInputRef.current;
    if (!showTmuxSendForm || !input) {
      return;
    }
    const interceptArmedInput = (event: InputEvent) => {
      // Non-cancelable input falls through to onChange, which reverts it.
      const typed = armedKeyModifierRef.current && event.cancelable ? typedKeyFromBeforeInput(event) : null;
      if (typed && consumeArmedKeyRef.current(typed)) {
        event.preventDefault();
      }
    };
    input.addEventListener("beforeinput", interceptArmedInput);
    return () => input.removeEventListener("beforeinput", interceptArmedInput);
  }, [showTmuxSendForm, selectedTmux]);

  useEffect(() => {
    loadStatus().catch(reportError(setError));
    loadTmuxSessions().catch(reportError(setError));
  }, [loadStatus, loadTmuxSessions]);

  useEffect(() => {
    if (demoMode) {
      return;
    }
    const refreshVisibleSessions = () => {
      if (!document.hidden) {
        loadTmuxSessions().catch(reportError(setError));
      }
    };
    const timer = window.setInterval(() => {
      refreshVisibleSessions();
    }, TMUX_SESSION_STATUS_POLL_INTERVAL_MS);
    document.addEventListener("visibilitychange", refreshVisibleSessions);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refreshVisibleSessions);
    };
  }, [loadTmuxSessions]);

  useEffect(() => {
    if (!status?.codex.initialized) {
      return;
    }
    loadModels().catch(reportError(setError));
    loadThreads().catch(reportError(setError));
  }, [loadModels, loadThreads, status?.codex.initialized]);

  useEffect(() => {
    if (!status?.codex.initialized) {
      return;
    }
    loadSkills().catch(reportError(setError));
  }, [loadSkills, status?.codex.initialized]);

  useLayoutEffect(() => {
    document.documentElement.dataset.theme = colorTheme;
    writeColorThemePreference(colorTheme);
  }, [colorTheme]);

  useEffect(() => {
    tmuxNotificationsEnabledRef.current = tmuxNotificationsEnabled;
    tmuxNotificationCursorRef.current = null;
    pendingTmuxNotificationEventsRef.current = [];

    if (!tmuxNotificationsEnabled) {
      setAndroidWatchPollingEnabled(false);
      return;
    }

    const snapshot = getBrowserNotificationSnapshot();
    if (snapshot.androidBridge) {
      setAndroidWatchPollingEnabled(true);
      return;
    }

    let active = true;
    void api<{ baselineEventId?: number; latestEventId: number }>("/api/tmux/watch/events?since=0")
      .then((result) => {
        if (!active || !tmuxNotificationsEnabledRef.current) {
          return;
        }
        let cursor = result.baselineEventId ?? result.latestEventId;
        const pending = pendingTmuxNotificationEventsRef.current
          .filter((event) => event.id > cursor)
          .sort((left, right) => left.id - right.id);
        pendingTmuxNotificationEventsRef.current = [];
        for (const event of pending) {
          cursor = Math.max(cursor, event.id);
          if (canShowWebSocketTaskNotifications()) {
            showTmuxNotification(event, tmuxNotificationDisplayName(event.session));
          }
        }
        tmuxNotificationCursorRef.current = cursor;
      })
      .catch(() => {
        if (active) {
          tmuxNotificationsEnabledRef.current = false;
          tmuxNotificationCursorRef.current = null;
          pendingTmuxNotificationEventsRef.current = [];
          setTmuxNotificationsEnabled(false);
          writeTmuxNotificationPreference(false);
          setTerminalStatus("notification watcher unavailable");
        }
      });
    return () => {
      active = false;
    };
  }, [tmuxNotificationsEnabled]);

  useEffect(() => {
    const handleOpenSession = (event: Event) => {
      const session = normalizeRequestedTmuxSession((event as CustomEvent<{ session?: unknown }>).detail?.session);
      if (session) {
        setRequestedTmuxSession(session);
      }
    };
    window.addEventListener("agent-tmux-open-session", handleOpenSession);
    return () => window.removeEventListener("agent-tmux-open-session", handleOpenSession);
  }, []);

  useEffect(() => {
    if (!requestedTmuxSession) {
      return;
    }

    clearTmuxFollowTimers(tmuxFollowTimersRef);
    initialTmuxViewAppliedRef.current = true;
    const requestedMode = preferredTmuxViewMode(requestedTmuxSession);
    applyCachedTmuxCaptureOrClear(requestedTmuxSession);
    applyTmuxViewMode(requestedMode);
    setTmuxMenuOpen(false);
    selectedTmuxRef.current = requestedTmuxSession;
    setSelectedTmux(requestedTmuxSession);
    setTerminalStatus(`${requestedTmuxSession} opened from notification`);
    queueTmuxOutputBottomScroll();
    clearRequestedTmuxSessionFromAddressBar();
    setRequestedTmuxSession("");
  }, [requestedTmuxSession]);

  useEffect(() => {
    if (selectedTmux) {
      let activeMode = tmuxViewModeRef.current;
      if (!initialTmuxViewAppliedRef.current) {
        initialTmuxViewAppliedRef.current = true;
        activeMode = preferredTmuxViewMode(selectedTmux);
        applyTmuxViewMode(activeMode);
      }
      if (activeMode === "tty") {
        queueTmuxOutputBottomScroll();
        captureTmux(selectedTmux, { source: "session" }).catch(reportError(setError));
      }
    }
  }, [captureTmux, selectedTmux]);

  useLayoutEffect(() => {
    if (terminalActive) {
      return;
    }

    const node = currentTmuxScrollNode();
    if (!node) {
      return;
    }

    if (forceTmuxScrollBottomRef.current || tmuxStickToBottomRef.current) {
      node.scrollTop = node.scrollHeight;
      forceTmuxScrollBottomRef.current = false;
      updateTmuxBottomState(node);
      tmuxScrollSnapshotRef.current = null;
      return;
    }

    if (tmuxScrollSnapshotRef.current) {
      restoreTmuxScrollSnapshot(node, tmuxScrollSnapshotRef.current);
    }
    tmuxScrollSnapshotRef.current = null;
    updateTmuxBottomState(node);
  }, [terminalActive, tmuxOutput, tmuxSidebar]);

  useLayoutEffect(() => {
    resizeTmuxInput(tmuxInputRef.current);
  }, [tmuxInput]);

  useEffect(() => {
    if (!selectedTmux || terminalActive) {
      return;
    }

    const interval = window.setInterval(() => {
      if (shouldAutoCaptureTmux({
        selectedTmux,
        terminalActive: terminalActiveRef.current,
        documentHidden: document.hidden
      })) {
        captureTmux(selectedTmux, { source: "poll" }).catch(reportError(setError));
      }
    }, TMUX_CAPTURE_POLL_INTERVAL_MS);

    return () => window.clearInterval(interval);
  }, [captureTmux, selectedTmux, terminalActive]);

  useEffect(() => {
    if (!selectedTmux || !terminalActive) {
      return;
    }

    const refreshCache = () => {
      if (!document.hidden) {
        void prefetchTmuxCapture(selectedTmux).catch(() => {
          // Raw remains usable when a speculative capture fails.
        });
      }
    };
    refreshCache();
    const interval = window.setInterval(refreshCache, TMUX_CAPTURE_POLL_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [prefetchTmuxCapture, selectedTmux, terminalActive]);

  useEffect(() => {
    if (demoMode) {
      return;
    }
    void dropAccessTokenFromAddressBar({
      token: initialAccessToken,
      isAndroidApp: Boolean(window.AgentTmuxAndroid),
      checkCookieSession: hasCookieSession,
      currentHref: () => window.location.href,
      replaceHref: (href) => window.history.replaceState(window.history.state, "", href)
    });
  }, []);

  useEffect(() => {
    if (demoMode) {
      return;
    }
    let socket: WebSocket | null = null;
    // Let React Strict Mode cancel its throwaway effect pass before opening a socket.
    const connectTimer = window.setTimeout(() => {
      const token = browserAccessToken();
      const protocol = window.location.protocol === "https:" ? "wss" : "ws";
      socket = new WebSocket(`${protocol}://${window.location.host}/ws${token ? `?token=${encodeURIComponent(token)}` : ""}`);
      socket.onmessage = (event) => {
        const payload = JSON.parse(event.data) as WsPayload;
        if (payload.type === "tmux-watch-done" && isTmuxWatchEvent(payload.event)) {
          handleTmuxNotificationEvent(payload.event);
          setTerminalStatus(payload.event.state === "idle"
            ? `${payload.event.session} is idle`
            : `${payload.event.session} is waiting for input`);
          return;
        }
        handleWsPayload(payload, setStatus, setThreadStatus, setTimeline, setActiveTurnId);
      };
      socket.onerror = () => setError("WebSocket connection failed");
    }, 0);
    return () => {
      window.clearTimeout(connectTimer);
      socket?.close();
    };
  }, []);

  useEffect(() => {
    scrollerRef.current?.scrollTo({ top: scrollerRef.current.scrollHeight, behavior: "smooth" });
  }, [timeline]);

  useEffect(() => {
    setSlashIndex(0);
  }, [slashQuery?.query]);

  useEffect(() => {
    return () => {
      clearTmuxFollowTimers(tmuxFollowTimersRef);
      cancelManualCapture(false);
    };
  }, []);

  useEffect(() => {
    if (!terminalActive || !selectedTmux || !terminalHostRef.current) {
      return;
    }

    const node = terminalHostRef.current;
    const session = selectedTmux;
    let rawTerminalEffectActive = true;
    node.textContent = "";

    const terminal = new XtermTerminal({
      allowProposedApi: false,
      convertEol: true,
      cursorBlink: true,
      fontFamily: "\"SFMono-Regular\", Consolas, \"Liberation Mono\", monospace",
      fontSize: 12,
      scrollback: 6000,
      theme: terminalThemeForColorTheme(colorTheme),
      vtExtensions: { kittyKeyboard: true }
    });
    const fitAddon = new FitAddon();
    const webLinksAddon = new WebLinksAddon((_event, uri) => {
      if (!openRawTerminalLink(uri)) {
        setTerminalStatus("Unable to open link");
      }
    });
    terminal.loadAddon(fitAddon);
    terminal.loadAddon(webLinksAddon);
    terminal.attachCustomKeyEventHandler((event) => {
      if (!shouldProcessRawTerminalKeyEvent(event)) {
        return false;
      }
      const extendedSequence = rawTerminalExtendedKeySequence(event);
      if (!extendedSequence) {
        return true;
      }
      if (event.type === "keydown") {
        event.preventDefault();
        event.stopPropagation();
        terminal.input(extendedSequence);
      }
      return false;
    });
    terminal.open(node);
    const removeRawTerminalInputGuard = mobileRawInput
      ? installRawTerminalInputGuard(terminal.textarea, terminal)
      : () => {};
    const handleRawTerminalPaste = (event: globalThis.ClipboardEvent) => {
      const clipboardData = event.clipboardData;
      if (!clipboardData) {
        return;
      }
      const pastedImageFiles = extractPastedImageFiles(clipboardData);
      if (pastedImageFiles.length === 0) {
        if (clipboardData.getData("text/plain") || clipboardData.types.length > 0) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        void pasteClipboardApiImagesIntoRawTerminal(terminal, session);
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      void pasteImagesIntoRawTerminal(
        pastedImageFiles,
        clipboardData.getData("text/plain"),
        terminal,
        session
      ).catch(reportError(setError));
    };
    node.addEventListener("paste", handleRawTerminalPaste, { capture: true });
    const removeRawTerminalGestureGuard = installRawTerminalGestureGuard(node);
    const terminalScreen = terminal.element?.querySelector<HTMLElement>(".xterm-screen") ?? null;
    const focusTerminalFromTap = (event: Event) => {
      if (!terminalScreen) {
        return;
      }
      const bounds = terminalScreen.getBoundingClientRect();
      const pageY = (event as Event & { pageY?: number }).pageY;
      if (shouldFocusRawTerminalTap({
        baseY: terminal.buffer.active.baseY,
        cursorY: terminal.buffer.active.cursorY,
        pageY,
        rows: terminal.rows,
        screenHeight: bounds.height,
        screenPageTop: bounds.top + window.scrollY,
        viewportY: terminal.buffer.active.viewportY
      })) {
        terminal.focus();
      }
    };
    terminalScreen?.addEventListener("-xterm-gesturetap", focusTerminalFromTap);
    rawTerminalRef.current = terminal;

    const selectionDisposable = terminal.onSelectionChange(createRawTerminalSelectionHandler({
      readSelection: () => terminal.getSelection(),
      writeClipboard: writeClipboardText,
      onCopied: () => {
        if (rawTerminalEffectActive) {
          setTerminalStatus("Copied selection");
        }
      },
      onError: (message) => {
        if (rawTerminalEffectActive) {
          setTerminalStatus(message);
        }
      }
    }));

    const fitTerminal = () => {
      try {
        fitAddon.fit();
      } catch {
        // The terminal can briefly be detached while React swaps views.
      }
      return { cols: terminal.cols || 80, rows: terminal.rows || 24 };
    };

    const dimensions = fitTerminal();
    let socket: WebSocket | null = null;

    const inputDisposable = terminal.onData((data) => {
      if (armedKeyModifierRef.current && isRawTypedCharacter(data) && consumeArmedKeyRef.current(data)) {
        return;
      }
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "input", data }));
      }
    });

    let lastSentDimensions = dimensions;
    let resizeFrame = 0;
    const sendResize = () => {
      const nextDimensions = fitTerminal();
      const dimensionsChanged = nextDimensions.cols !== lastSentDimensions.cols || nextDimensions.rows !== lastSentDimensions.rows;
      if (dimensionsChanged && socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "resize", ...nextDimensions }));
        lastSentDimensions = nextDimensions;
      }
    };
    const resize = () => {
      if (resizeFrame) {
        return;
      }
      resizeFrame = window.requestAnimationFrame(() => {
        resizeFrame = 0;
        sendResize();
      });
    };

    if (demoMode) {
      terminal.write(DEMO_RAW_TERMINAL_OUTPUT);
      setTerminalStatus(`live terminal for ${session}`);
      if (!mobileRawInput) {
        terminal.focus();
      }
    } else {
      const params = new URLSearchParams({
        session,
        clientId: BROWSER_CLIENT_ID,
        cols: String(dimensions.cols),
        rows: String(dimensions.rows)
      });
      const token = browserAccessToken();
      if (token) {
        params.set("token", token);
      }

      const protocol = window.location.protocol === "https:" ? "wss" : "ws";
      socket = new WebSocket(`${protocol}://${window.location.host}/tmux-ws?${params}`);
      const terminalSocket = socket;
      setTerminalStatus(`connecting to ${session}`);

      terminalSocket.onopen = () => {
        terminalSocketRef.current = terminalSocket;
        terminalSessionRef.current = session;
        setTerminalStatus(`live terminal for ${session}`);
        if (!mobileRawInput) {
          terminal.focus();
        }
      };
      terminalSocket.onmessage = (event) => {
        const payload = parseTerminalSocketMessage(event.data);
        if (!payload) {
          return;
        }
        if (payload.type === "output" && typeof payload.data === "string") {
          terminal.write(payload.data);
        }
        if (payload.type === "status" && typeof payload.message === "string") {
          setTerminalStatus(payload.message);
        }
        if (payload.type === "error" && typeof payload.message === "string") {
          setTerminalStatus(payload.message);
          terminal.writeln(`\r\n${payload.message}`);
        }
      };
      terminalSocket.onclose = () => {
        if (terminalSocketRef.current === terminalSocket) {
          terminalSocketRef.current = null;
          terminalSessionRef.current = "";
        }
        setTerminalStatus(`terminal closed for ${session}`);
      };
      terminalSocket.onerror = () => {
        setTerminalStatus(`terminal connection failed for ${session}`);
      };
      terminalSocket.addEventListener("open", sendResize);
    }

    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(node);
    window.addEventListener("resize", resize);
    const resizeTimer = window.setTimeout(resize, 50);

    return () => {
      rawTerminalEffectActive = false;
      window.clearTimeout(resizeTimer);
      if (resizeFrame) {
        window.cancelAnimationFrame(resizeFrame);
      }
      socket?.removeEventListener("open", sendResize);
      window.removeEventListener("resize", resize);
      node.removeEventListener("paste", handleRawTerminalPaste, { capture: true });
      resizeObserver.disconnect();
      terminalScreen?.removeEventListener("-xterm-gesturetap", focusTerminalFromTap);
      inputDisposable.dispose();
      selectionDisposable.dispose();
      if (socket && terminalSocketRef.current === socket) {
        terminalSocketRef.current = null;
        terminalSessionRef.current = "";
      }
      if (rawTerminalRef.current === terminal) {
        rawTerminalRef.current = null;
      }
      if (socket) {
        socket.onopen = null;
        socket.onmessage = null;
        socket.onerror = null;
        socket.onclose = null;
        socket.close();
      }
      removeRawTerminalGestureGuard();
      removeRawTerminalInputGuard();
      terminal.dispose();
    };
  }, [colorTheme, mobileRawInput, rawTerminalConnectionId, selectedTmux, terminalActive]);

  async function sendMessage(event: FormEvent) {
    event.preventDefault();
    if (uploadingComposerFiles) {
      return;
    }
    const text = message.trim();
    if (!text) {
      return;
    }

    setError("");
    if (await runSlashCommand(text)) {
      setMessage("");
      setComposerCaret(0);
      return;
    }

    setMessage("");
    setComposerCaret(0);

    let currentThreadId = threadId;
    if (!currentThreadId) {
      const created = await api<{ thread: { id: string }; reasoningEffort?: string }>("/api/thread/start", {
        method: "POST",
        body: JSON.stringify({ cwd, model, serviceTier: "fast" })
      });
      currentThreadId = created.thread.id;
      setThreadId(currentThreadId);
    }

    addUserEntry(setTimeline, text);
    const result = await api<{ turn: { id: string; status: string } }>("/api/turn/start", {
      method: "POST",
      body: JSON.stringify({
        threadId: currentThreadId,
        text,
        cwd,
        model,
        effort,
        serviceTier: "fast"
      })
    });
    setActiveTurnId(result.turn.id);
    setThreadStatus(result.turn.status);
  }

  async function resumeThread(id: string) {
    setError("");
    const result = await api<{ thread: { id: string; cwd: string; status: string; turns: Array<{ items: unknown[] }> } }>("/api/thread/resume", {
      method: "POST",
      body: JSON.stringify({ threadId: id, cwd, model })
    });
    setThreadId(result.thread.id);
    setThreadStatus(result.thread.status);
    await readThread(result.thread.id);
  }

  async function readThread(id: string) {
    const result = await api<{ thread: { id: string; turns: Array<{ items: unknown[] }> } }>(`/api/thread/${id}`);
    setTimeline(threadToEntries(result.thread.turns));
  }

  async function interruptTurn() {
    if (!threadId) {
      return;
    }
    await api("/api/turn/interrupt", {
      method: "POST",
      body: JSON.stringify({ threadId })
    });
  }

  async function sendTmux() {
    const text = tmuxInputRef.current?.value ?? tmuxInput;
    if (!selectedTmux || !text.trim()) {
      return;
    }
    const session = selectedTmux;
    queueTmuxOutputBottomScroll();

    if (demoMode) {
      setCapturedTmuxOutput(`${DEMO_TMUX_OUTPUT}\n\n› ${text}\n\n• Demo input captured without touching a real tmux session.`, DEMO_TMUX_SIDEBAR);
      setTmuxInput("");
      resizeTmuxInput(tmuxInputRef.current);
      setTerminalStatus(`sent to ${session}; following output`);
      return;
    }

    if (sendTmuxViaTerminal(session, text)) {
      setTmuxInput("");
      if (tmuxInputRef.current) {
        tmuxInputRef.current.value = "";
      }
      resizeTmuxInput(tmuxInputRef.current);
      setTerminalStatus(`sent to ${session}`);
      return;
    }

    await api("/api/tmux/send", {
      method: "POST",
      body: JSON.stringify({ session, text, enter: true })
    });
    setTmuxInput("");
    if (tmuxInputRef.current) {
      tmuxInputRef.current.value = "";
    }
    resizeTmuxInput(tmuxInputRef.current);
    setTerminalStatus(`sent to ${session}; following output`);
    scheduleTmuxFollow(session);
  }

  async function interruptTmux() {
    if (!selectedTmux) {
      return;
    }
    queueTmuxOutputBottomScroll();
    if (demoMode) {
      setTerminalStatus(`stop sent to ${selectedTmux}`);
      return;
    }
    const result = await api<TmuxCaptureDto & { ok: true }>("/api/tmux/interrupt", {
      method: "POST",
      body: JSON.stringify({ session: selectedTmux })
    });
    setCapturedTmuxOutput(result.output, result.sidebar);
    setTerminalStatus(`stop sent to ${selectedTmux}`);
    scheduleTmuxFollow(selectedTmux);
  }

  async function uploadFilesForPrompt(selectedFiles: File[]): Promise<UploadedFileDto[]> {
    if (demoMode) {
      return selectedFiles.map((file) => ({
        name: file.name || "upload",
        reference: `~/.agent-tmux/attachments/demo/${file.name || "upload"}`,
        size: file.size,
        mimeType: file.type || null
      }));
    }

    const uploads: UploadedFileDto[] = [];
    for (const file of selectedFiles) {
      uploads.push(await uploadFileToServer(file));
    }
    return uploads;
  }

  async function attachTmuxFiles(files: FileList | File[] | null) {
    const selectedFiles = Array.from(files ?? []);
    if (selectedFiles.length === 0) {
      return;
    }

    setError("");
    setUploadingTmuxFiles(true);
    try {
      const uploads = await uploadFilesForPrompt(selectedFiles);
      appendTmuxPromptText(formatUploadedFilesForPrompt(uploads));
      setTerminalStatus(`uploaded ${uploads.length} file${uploads.length === 1 ? "" : "s"}; inserted safe attachment reference${uploads.length === 1 ? "" : "s"}`);
    } finally {
      setUploadingTmuxFiles(false);
    }
  }

  async function pasteImagesIntoComposer(files: File[], pastedText: string, sourceInput: HTMLTextAreaElement) {
    setError("");
    setUploadingComposerFiles(true);
    try {
      const uploads = await uploadFilesForPrompt(files);
      insertComposerPromptText(buildPastedPromptText(pastedText, formatUploadedFilesForPrompt(uploads)), sourceInput);
    } finally {
      setUploadingComposerFiles(false);
    }
  }

  async function pasteImagesIntoTmuxPrompt(files: File[], pastedText: string, sourceInput: HTMLTextAreaElement) {
    setError("");
    setUploadingTmuxFiles(true);
    try {
      const uploads = await uploadFilesForPrompt(files);
      insertTmuxPromptText(buildPastedPromptText(pastedText, formatUploadedFilesForPrompt(uploads)), sourceInput);
      setTerminalStatus(`uploaded ${uploads.length} pasted image${uploads.length === 1 ? "" : "s"}; inserted safe attachment reference${uploads.length === 1 ? "" : "s"}`);
    } finally {
      setUploadingTmuxFiles(false);
    }
  }

  async function pasteImagesIntoRawTerminal(files: File[], pastedText: string, terminal: XtermTerminal, session: string) {
    setError("");
    setUploadingTmuxFiles(true);
    try {
      const uploads = await uploadFilesForPrompt(files);
      if (rawTerminalRef.current !== terminal || selectedTmuxRef.current !== session) {
        return;
      }
      terminal.paste(buildPastedPromptText(pastedText, formatUploadedFilesForPrompt(uploads)));
      setTerminalStatus(`uploaded ${uploads.length} pasted image${uploads.length === 1 ? "" : "s"}; inserted safe attachment reference${uploads.length === 1 ? "" : "s"}`);
    } finally {
      setUploadingTmuxFiles(false);
    }
  }

  async function pasteClipboardApiImagesIntoRawTerminal(terminal: XtermTerminal, session: string) {
    try {
      const files = await readClipboardImageFiles();
      if (files.length > 0) {
        await pasteImagesIntoRawTerminal(files, "", terminal, session);
        return;
      }
    } catch {
      // Clipboard reads require a secure origin and may be denied by the client.
    }
    if (rawTerminalRef.current === terminal && selectedTmuxRef.current === session) {
      setTerminalStatus("Clipboard did not expose an image; use Ctrl-V");
    }
  }

  function insertComposerPromptText(text: string, sourceInput?: HTMLTextAreaElement | null) {
    const input = composerRef.current ?? sourceInput ?? null;
    const value = input?.value ?? message;
    const selectionStart = input?.selectionStart ?? value.length;
    const selectionEnd = input?.selectionEnd ?? selectionStart;
    const next = applyTextareaPaste(value, selectionStart, selectionEnd, text);

    if (input) {
      input.value = next.value;
    }
    setMessage(next.value);
    setComposerCaret(next.selectionStart);
    window.requestAnimationFrame(() => {
      input?.focus();
      input?.setSelectionRange(next.selectionStart, next.selectionEnd);
    });
  }

  function insertTmuxPromptText(text: string, sourceInput?: HTMLTextAreaElement | null) {
    const input = tmuxInputRef.current ?? sourceInput ?? null;
    const value = input?.value ?? tmuxInput;
    const selectionStart = input?.selectionStart ?? value.length;
    const selectionEnd = input?.selectionEnd ?? selectionStart;
    const next = applyTextareaPaste(value, selectionStart, selectionEnd, text);

    if (input) {
      input.value = next.value;
    }
    setTmuxInput(next.value);
    resizeTmuxInput(input);
    window.requestAnimationFrame(() => {
      input?.focus();
      input?.setSelectionRange(next.selectionStart, next.selectionEnd);
      resizeTmuxInput(input);
    });
  }

  function appendTmuxPromptText(text: string) {
    setTmuxInput((current) => {
      const value = tmuxInputRef.current?.value ?? current;
      const trimmed = value.trimEnd();
      return trimmed ? `${trimmed} ${text}` : text;
    });
    window.requestAnimationFrame(() => {
      const input = tmuxInputRef.current;
      if (!input) {
        return;
      }
      input.focus();
      resizeTmuxInput(input);
      const end = input.value.length;
      input.setSelectionRange(end, end);
    });
  }

  function isCurrentManualCaptureOwner(owner: number): boolean {
    return isCurrentTmuxCaptureOwner({
      activeManualOwner: manualCaptureOwnerRef.current,
      owner
    });
  }

  function releaseManualCapture(owner: number, updateState = true): boolean {
    if (!isCurrentManualCaptureOwner(owner)) {
      return false;
    }
    if (manualCaptureTimeoutRef.current !== null) {
      window.clearTimeout(manualCaptureTimeoutRef.current);
    }
    manualCaptureTimeoutRef.current = null;
    manualCaptureControllerRef.current = null;
    manualCaptureOwnerRef.current = null;
    if (updateState) {
      setManualCaptureActive(false);
    }
    return true;
  }

  function cancelManualCapture(updateState = true) {
    const owner = manualCaptureOwnerRef.current;
    if (owner === null) {
      return;
    }
    manualCaptureControllerRef.current?.abort();
    releaseManualCapture(owner, updateState);
  }

  function applyTmuxViewMode(mode: TmuxViewMode) {
    cancelManualCapture();
    tmuxViewEpochRef.current += 1;
    tmuxViewModeRef.current = mode;
    terminalActiveRef.current = mode === "raw";
    setTmuxViewModeState(mode);
  }

  function preferredTmuxViewMode(session: string): TmuxViewMode {
    return resolveTmuxViewMode(session, defaultTmuxViewMode, tmuxViewSwitchPolicy, tmuxSessionViewModes);
  }

  function rememberTmuxViewMode(session: string, mode: TmuxViewMode) {
    setTmuxSessionViewModes((current) => {
      const next = { ...current, [session]: mode };
      writeStoredJson(TMUX_SESSION_VIEWS_STORAGE_KEY, next);
      return next;
    });
  }

  function openRawTerminal() {
    if (!selectedTmux) {
      return;
    }
    if (demoMode) {
      clearTmuxFollowTimers(tmuxFollowTimersRef);
      setTerminalStatus(`live terminal for ${selectedTmux}`);
      applyTmuxViewMode("raw");
      return;
    }
    clearTmuxFollowTimers(tmuxFollowTimersRef);
    setTerminalStatus(`connecting to ${selectedTmux}`);
    applyTmuxViewMode("raw");
  }

  function refreshTmux() {
    if (manualCaptureOwnerRef.current !== null) {
      return;
    }
    void loadTmuxSessions().catch(reportError(setError));
    if (!selectedTmux) {
      setTerminalStatus("refreshing sessions");
      return;
    }
    const session = selectedTmux;
    if (tmuxViewMode === "raw") {
      setTerminalStatus(`refreshing ${session}`);
      setRawTerminalConnectionId((current) => current + 1);
      return;
    }
    clearTmuxFollowTimers(tmuxFollowTimersRef);
    const owner = ++manualCaptureOwnerSequenceRef.current;
    const controller = new AbortController();
    manualCaptureOwnerRef.current = owner;
    manualCaptureControllerRef.current = controller;
    setManualCaptureActive(true);
    manualCaptureTimeoutRef.current = window.setTimeout(() => {
      if (!isCurrentManualCaptureOwner(owner)) {
        return;
      }
      controller.abort();
      setTerminalStatus(`sync timed out for ${session}`);
      releaseManualCapture(owner);
    }, TMUX_MANUAL_CAPTURE_TIMEOUT_MS);
    setTerminalStatus(`syncing ${session}`);
    void captureTmux(session, {
      source: "manual",
      owner,
      signal: controller.signal
    })
      .then((applied) => {
        if (applied && isCurrentManualCaptureOwner(owner)) {
          setTerminalStatus(`synced ${session}`);
        }
      })
      .catch(() => {
        if (isCurrentManualCaptureOwner(owner) && !controller.signal.aborted) {
          setTerminalStatus(`sync failed for ${session}`);
        }
      })
      .finally(() => {
        releaseManualCapture(owner);
      });
  }

  function closeTmuxSettingsMenu() {
    tmuxSettingsMenuRef.current?.removeAttribute("open");
  }

  function selectTmuxViewMode(mode: TmuxViewMode) {
    if (!selectedTmux) {
      return;
    }

    rememberTmuxViewMode(selectedTmux, mode);

    if (mode === "raw") {
      openRawTerminal();
      return;
    }

    clearTmuxFollowTimers(tmuxFollowTimersRef);
    applyTmuxViewMode(mode);
    setTerminalStatus(`${TMUX_VIEW_MODE_LABELS[mode].toLowerCase()} view for ${selectedTmux}`);
    applyCachedTmuxCapture(selectedTmux);
    queueTmuxOutputBottomScroll();
    void captureTmux(selectedTmux, { source: "view" }).catch(reportError(setError));
  }

  function selectColorTheme(theme: ColorTheme) {
    closeTmuxSettingsMenu();
    if (theme === colorTheme) {
      return;
    }
    setColorTheme(theme);
    setTerminalStatus(theme === "light" ? "light mode on" : "dark mode on");
  }

  function selectDefaultTmuxViewMode(mode: TmuxViewMode) {
    setDefaultTmuxViewMode(mode);
    writeStoredValue(DEFAULT_TMUX_VIEW_STORAGE_KEY, mode);
    setTerminalStatus(`default view set to ${TMUX_VIEW_MODE_LABELS[mode]}`);
  }

  function selectTmuxViewSwitchPolicy(policy: TmuxViewSwitchPolicy) {
    setTmuxViewSwitchPolicy(policy);
    writeStoredValue(TMUX_VIEW_SWITCH_POLICY_STORAGE_KEY, policy);
    setTerminalStatus(policy === "remember" ? "remembering each session view" : "always using the default view");
  }

  function showAndroidConnectionSettings() {
    closeTmuxSettingsMenu();
    if (!openAndroidConnectionSettings()) {
      setError("Unable to open Android connection settings");
    }
  }

  async function copyServerUrl() {
    const url = baseUrl || window.location.origin;
    await writeClipboardText(url);
    closeTmuxSettingsMenu();
    setTerminalStatus("Copied server URL");
  }

  async function toggleTmuxNotifications() {
    if (tmuxNotificationsEnabled) {
      tmuxNotificationsEnabledRef.current = false;
      setTmuxNotificationsEnabled(false);
      writeTmuxNotificationPreference(false);
      setTerminalStatus("browser notifications off");
      return;
    }

    const snapshot = getBrowserNotificationSnapshot();
    const availability = getBrowserNotificationAvailability(snapshot);
    if (!availability.available) {
      setTerminalStatus(availability.message);
      return;
    }

    if (snapshot.androidBridge) {
      tmuxNotificationsEnabledRef.current = true;
      setTmuxNotificationsEnabled(true);
      writeTmuxNotificationPreference(true);
      setAndroidWatchPollingEnabled(true);
      setTerminalStatus("app notifications on");
      return;
    }

    let permission: NotificationPermission;
    try {
      permission = Notification.permission === "default"
        ? await Notification.requestPermission()
        : Notification.permission;
    } catch {
      setTerminalStatus("browser blocked notification prompt");
      return;
    }

    if (permission === "granted") {
      tmuxNotificationsEnabledRef.current = true;
      tmuxNotificationCursorRef.current = null;
      setTmuxNotificationsEnabled(true);
      writeTmuxNotificationPreference(true);
      setTerminalStatus("browser notifications on");
      return;
    }

    setTmuxNotificationsEnabled(false);
    writeTmuxNotificationPreference(false);
    const nextAvailability = getBrowserNotificationAvailability({
      ...getBrowserNotificationSnapshot(),
      permission
    });
    setTerminalStatus(nextAvailability.available ? "browser notifications not enabled" : nextAvailability.message);
  }

  function handleTmuxNotificationEvent(event: TmuxWatchEvent) {
    if (!tmuxNotificationsEnabledRef.current || !canShowWebSocketTaskNotifications()) {
      return;
    }
    const cursor = tmuxNotificationCursorRef.current;
    if (cursor === null) {
      pendingTmuxNotificationEventsRef.current.push(event);
      return;
    }
    if (event.id <= cursor) {
      return;
    }
    tmuxNotificationCursorRef.current = event.id;
    showTmuxNotification(event, tmuxNotificationDisplayName(event.session));
  }

  function tmuxNotificationDisplayName(target: string): string | undefined {
    const entry = findTmuxPane(tmuxSessionsRef.current, target);
    return entry ? tmuxPaneDisplayName(entry) : undefined;
  }

  function sendRawTerminalData(data: string) {
    if (demoMode && terminalActive) {
      setTerminalStatus(`sent ${describeTerminalKey(data)} to ${selectedTmux}`);
      return;
    }
    const socket = terminalSocketRef.current;
    if (!terminalActive || !socket || socket.readyState !== WebSocket.OPEN) {
      setTerminalStatus("raw terminal not connected");
      return;
    }
    socket.send(JSON.stringify({ type: "input", data }));
  }

  function setArmedKeyModifier(modifier: KeyStripModifier | null) {
    armedKeyModifierRef.current = modifier;
    setArmedKeyModifierState(modifier);
  }

  function toggleArmedKeyModifier(modifier: KeyStripModifier) {
    const next = toggleKeyStripModifier(armedKeyModifierRef.current, modifier);
    setArmedKeyModifier(next);
    if (next) {
      if (terminalActive) {
        rawTerminalRef.current?.focus();
      } else {
        tmuxInputRef.current?.focus();
      }
    }
  }

  function pressKeyStripKey(key: KeyStripKey) {
    const modifier = armedKeyModifierRef.current;
    setArmedKeyModifier(null);
    sendKeyStripCombo(key, modifier);
  }

  // The next typed character goes to the pane as a combo instead of into the input.
  function consumeArmedKey(typed: string): boolean {
    const modifier = armedKeyModifierRef.current;
    if (!modifier) {
      return false;
    }
    setArmedKeyModifier(null);
    sendKeyStripCombo(typed, modifier);
    return true;
  }
  consumeArmedKeyRef.current = consumeArmedKey;

  function sendKeyStripCombo(key: string, modifier: KeyStripModifier | null) {
    const modifierLabel = modifier === "ctrl" ? "Ctrl" : "Alt";
    if (terminalActive) {
      const bytes = rawKeyBytes(key, modifier);
      if (bytes) {
        sendRawTerminalData(bytes);
      } else {
        setTerminalStatus(`no ${modifierLabel}-${key} key`);
      }
      return;
    }
    const name = tmuxKeyName(key, modifier);
    if (!name) {
      setTerminalStatus(`no ${modifierLabel}-${key} key`);
      return;
    }
    sendTmuxKey(name).catch(reportError(setError));
  }

  async function sendTmuxKey(key: string) {
    const session = selectedTmux;
    if (!session) {
      return;
    }
    queueTmuxOutputBottomScroll();
    if (demoMode) {
      setTerminalStatus(`sent ${key} to ${session}`);
      return;
    }
    await api<{ ok: true }>("/api/tmux/keys", {
      method: "POST",
      body: JSON.stringify({ session, key })
    });
    setTerminalStatus(`sent ${key} to ${session}`);
    scheduleTmuxFollow(session);
  }

  function sendTmuxViaTerminal(session: string, text: string): boolean {
    const socket = terminalSocketRef.current;
    if (!terminalActive || terminalSessionRef.current !== session || !socket || socket.readyState !== WebSocket.OPEN) {
      return false;
    }

    sendTerminalSocketInput(socket, text);
    window.setTimeout(() => {
      if (terminalSocketRef.current === socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "input", data: "\r" }));
      }
    }, TMUX_TERMINAL_SUBMIT_DELAY_MS);
    return true;
  }

  async function closeSelectedTmuxPane() {
    const target = selectedTmux;
    const entry = findTmuxPane(tmuxSessions, target);
    if (!entry?.paneId || !window.confirm(`Close pane "${tmuxPaneDisplayName(entry)}" (${tmuxPaneShortName(entry)})? Whatever runs in it is killed.`)) {
      return;
    }
    closeTmuxSettingsMenu();
    const remaining = demoMode
      ? tmuxSessions.filter((pane) => pane.name !== target)
      : (await api<{ data: TmuxSessionDto[] }>("/api/tmux/close-pane", {
        method: "POST",
        body: JSON.stringify({ pane: target })
      })).data;
    setTmuxSessions(remaining);
    if (selectedTmuxRef.current !== target) {
      return;
    }
    // Prefer another agent pane so the rail selection stays inside the default filter.
    const next = defaultTmuxPaneSelection(filterTmuxAgentPanes(remaining, showAllTmuxPanes, "")) || defaultTmuxPaneSelection(remaining);
    if (next) {
      selectTmuxSession(next);
      return;
    }
    selectedTmuxRef.current = "";
    setSelectedTmux("");
    setCapturedTmuxOutput("", undefined);
    setTerminalStatus("no session selected");
  }

  function openWindowSnoozeSheet() {
    if (selectedTmuxSnoozable) {
      closeTmuxSettingsMenu();
      setWindowSnoozeTarget(selectedTmux);
    }
  }

  async function snoozeTmuxWindow(target: string, duration: string) {
    const railBefore = visibleTmuxRailPanes(railTmuxPanes, pinnedTmuxSessionNames, tmuxSessionGroupPreferences);
    const remaining = (await api<{ data: TmuxSessionDto[] }>("/api/tmux/snooze", {
      method: "POST",
      body: JSON.stringify({ target, duration })
    })).data;
    setWindowSnoozeTarget("");
    setTmuxSessions(remaining);
    setTerminalStatus(`snoozed ${target}'s window for ${duration}`);
    if (selectedTmuxRef.current !== target) {
      return;
    }
    // The window moved to _hidden, so its rows left their group; carry on with the next row.
    const railAfter = visibleTmuxRailPanes(filterTmuxAgentPanes(remaining, showAllTmuxPanes, ""), pinnedTmuxSessionNames, tmuxSessionGroupPreferences);
    const next = nextTmuxRailPaneAfter(railBefore, target, railAfter);
    if (next) {
      selectTmuxSession(next);
    }
  }

  async function wakeTmuxWindow(target: string) {
    const remaining = (await api<{ data: TmuxSessionDto[] }>("/api/tmux/wake-window", {
      method: "POST",
      body: JSON.stringify({ target })
    })).data;
    setWindowSnoozeTarget("");
    setTmuxSessions(remaining);
    setTerminalStatus(`woke ${target}'s window`);
  }

  function handleAgentStarted(result: StartAgentResultDto) {
    setNewAgentOpen(false);
    setTmuxSessions(result.sessions);
    selectTmuxSession(result.pane);
  }

  function selectTmuxSession(session: string) {
    clearTmuxFollowTimers(tmuxFollowTimersRef);
    initialTmuxViewAppliedRef.current = true;
    selectedTmuxRef.current = session;
    setSelectedTmux(session);
    const mode = preferredTmuxViewMode(session);
    applyCachedTmuxCaptureOrClear(session);
    applyTmuxViewMode(mode);
    setTmuxMenuOpen(false);
    setTerminalStatus(`${TMUX_VIEW_MODE_LABELS[mode].toLowerCase()} view for ${session}`);
  }

  function toggleTmuxSessionPin(sessionName: string) {
    const nextPinnedSessionNames = togglePinnedTmuxSessionName(pinnedTmuxSessionNames, sessionName);
    setPinnedTmuxSessionNames(nextPinnedSessionNames);
    writeStoredJson(PINNED_TMUX_SESSIONS_STORAGE_KEY, nextPinnedSessionNames);
    setTerminalStatus(`${nextPinnedSessionNames.includes(sessionName) ? "pinned" : "unpinned"} ${sessionName}`);
  }

  function toggleShowAllTmuxPanes() {
    const next = !showAllTmuxPanes;
    setShowAllTmuxPanes(next);
    writeStoredValue(SHOW_ALL_TMUX_PANES_STORAGE_KEY, next ? "1" : "0");
    setTerminalStatus(next ? "showing all panes" : "showing agent panes only");
  }

  function setTmuxSessionGroupCollapsedPreference(session: string, collapsed: boolean) {
    setTmuxSessionGroupPreferences((current) => {
      const next = setTmuxSessionGroupCollapsed(current, session, collapsed);
      writeStoredJson(TMUX_SESSION_GROUPS_STORAGE_KEY, next);
      return next;
    });
  }

  function insertSkillName(skillName: string) {
    setMessage((current) => {
      const prefix = current.trimEnd();
      return prefix ? `${prefix} ${skillName}` : skillName;
    });
  }

  async function runSlashCommand(text: string): Promise<boolean> {
    const parsed = parseSlashCommand(text);
    if (!parsed) {
      return false;
    }

    const command = slashMatches.find((entry) => entry.name === parsed.name) ?? filterSlashCommands(parsed.name).find((entry) => entry.name === parsed.name);
    if (!command) {
      addLocalEntry(setTimeline, "Slash command", `Unknown command: ${parsed.name}`);
      return true;
    }

    if (!command.local) {
      addLocalEntry(
        setTimeline,
        command.name,
        `${command.description}\n\n${command.detail}\n\nFor exact CLI behavior, attach to a tmux session and run it there.`
      );
      return true;
    }

    if (command.name === "/clear" || command.name === "/new") {
      setThreadId("");
      setActiveTurnId("");
      setThreadStatus("idle");
      setTimeline([]);
      addLocalEntry(setTimeline, command.name, "Started a fresh web conversation.");
      return true;
    }

    if (command.name === "/status") {
      addLocalEntry(setTimeline, "/status", [
        `URL: ${baseUrl || "loading"}`,
        `Thread: ${threadId || "new"}`,
        `Model: ${model}`,
        `Reasoning: ${effort}`,
        `Working directory: ${cwd}`,
        `Codex app-server: ${status?.codex.initialized ? "connected" : "optional/offline"}`,
        `Tmux: ${selectedTmux || "none selected"}`
      ].join("\n"));
      return true;
    }

    if (command.name === "/model") {
      const [nextModel, nextEffort] = parsed.args.split(/\s+/).filter(Boolean);
      if (!nextModel) {
        addLocalEntry(setTimeline, "/model", `Current model: ${model}\nCurrent reasoning: ${effort}\n\nUsage: /model <model> [${modelEfforts.join("|")}]`);
        return true;
      }

      const matchedModel = models.find((entry) => [entry.id, entry.model, entry.displayName].includes(nextModel));
      if (!matchedModel) {
        addLocalEntry(setTimeline, "/model", `Unknown model: ${nextModel}`);
        return true;
      }

      setModel(matchedModel.id);
      const supportedEfforts = matchedModel.supportedReasoningEfforts.map((entry) => entry.reasoningEffort);
      if (nextEffort && supportedEfforts.includes(nextEffort)) {
        setEffort(nextEffort);
      }
      addLocalEntry(setTimeline, "/model", `Model set to ${matchedModel.displayName}${nextEffort ? ` with ${nextEffort} reasoning` : ""}.`);
      return true;
    }

    if (command.name === "/fast") {
      addLocalEntry(setTimeline, "/fast", "Fast mode is on for web turns through the local app-server.");
      return true;
    }

    if (command.name === "/stop") {
      await interruptTurn();
      addLocalEntry(setTimeline, "/stop", "Interrupt requested for the current web turn.");
      return true;
    }

    if (command.name === "/resume") {
      await loadThreads();
      addLocalEntry(setTimeline, "/resume", "Recent thread list refreshed. Choose a thread from the sidebar.");
      return true;
    }

    if (command.name === "/copy") {
      const latest = [...timeline].reverse().find((entry) => entry.title === "Agent" || entry.title === "Codex" || entry.kind.includes("assistant"));
      if (!latest?.body) {
        addLocalEntry(setTimeline, "/copy", "No completed agent output is visible yet.");
        return true;
      }
      await writeClipboardText(latest.body);
      addLocalEntry(setTimeline, "/copy", "Latest visible agent output copied.");
      return true;
    }

    if (command.name === "/exit" || command.name === "/quit") {
      applyTmuxViewMode("tty");
      addLocalEntry(setTimeline, command.name, "Detached the browser terminal view.");
      return true;
    }

    return false;
  }

  function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (!slashQuery || slashMatches.length === 0) {
      if (shouldSubmitTextareaEnter(event)) {
        event.preventDefault();
        event.currentTarget.form?.requestSubmit();
      }
      return;
    }

    if (event.key === "ArrowDown") {
      event.preventDefault();
      setSlashIndex((current) => (current + 1) % slashMatches.length);
      return;
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();
      setSlashIndex((current) => (current - 1 + slashMatches.length) % slashMatches.length);
      return;
    }

    if (event.key === "Tab" || shouldSubmitTextareaEnter(event)) {
      event.preventDefault();
      chooseSlashCommand(slashMatches[slashIndex] ?? slashMatches[0]);
      return;
    }

    if (event.key === "Escape") {
      event.preventDefault();
      setComposerCaret(-1);
    }
  }

  function handleComposerPaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const pastedImageFiles = extractPastedImageFiles(event.clipboardData);
    if (pastedImageFiles.length > 0) {
      event.preventDefault();
      const pastedText = event.clipboardData.getData("text/plain");
      void pasteImagesIntoComposer(pastedImageFiles, pastedText, event.currentTarget).catch(reportError(setError));
      return;
    }

    const pastedText = event.clipboardData.getData("text/plain");
    if (!pastedText) {
      return;
    }

    event.preventDefault();
    const input = event.currentTarget;
    const next = applyTextareaPaste(input.value, input.selectionStart, input.selectionEnd, pastedText);
    input.value = next.value;
    setMessage(next.value);
    setComposerCaret(next.selectionStart);
    window.requestAnimationFrame(() => {
      input.focus();
      input.setSelectionRange(next.selectionStart, next.selectionEnd);
    });
  }

  function handleTmuxInputPaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const pastedImageFiles = extractPastedImageFiles(event.clipboardData);
    if (pastedImageFiles.length > 0) {
      event.preventDefault();
      const pastedText = event.clipboardData.getData("text/plain");
      void pasteImagesIntoTmuxPrompt(pastedImageFiles, pastedText, event.currentTarget).catch(reportError(setError));
      return;
    }

    const pastedText = event.clipboardData.getData("text/plain");
    if (!pastedText) {
      return;
    }

    event.preventDefault();
    const input = event.currentTarget;
    const next = applyTextareaPaste(input.value, input.selectionStart, input.selectionEnd, pastedText);
    input.value = next.value;
    setTmuxInput(next.value);
    resizeTmuxInput(input);
    window.requestAnimationFrame(() => {
      input.focus();
      input.setSelectionRange(next.selectionStart, next.selectionEnd);
      resizeTmuxInput(input);
    });
  }

  function handleTmuxInputKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    const typed = armedKeyModifierRef.current ? typedKeyFromKeyDown({
      key: event.key,
      keyCode: event.keyCode,
      isComposing: event.nativeEvent.isComposing,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      altKey: event.altKey
    }) : null;
    if (typed && consumeArmedKey(typed)) {
      event.preventDefault();
      return;
    }
    if (shouldSubmitTextareaEnter(event)) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  }

  function chooseSlashCommand(command: SlashCommand) {
    const next = replaceSlashQuery(message, composerCaret, command.name);
    setMessage(next.message);
    setComposerCaret(next.selectionStart);
    window.requestAnimationFrame(() => {
      composerRef.current?.focus();
      composerRef.current?.setSelectionRange(next.selectionStart, next.selectionStart);
    });
  }

  function scheduleTmuxFollow(session: string) {
    queueTmuxOutputBottomScroll();
    clearTmuxFollowTimers(tmuxFollowTimersRef);
    void captureTmux(session, { source: "follow" }).catch(reportError(setError));
    for (const delay of TMUX_SEND_FOLLOW_DELAYS_MS) {
      const timer = window.setTimeout(() => {
        void captureTmux(session, { source: "follow" }).catch(reportError(setError));
      }, delay);
      tmuxFollowTimersRef.current.push(timer);
    }
  }

  function setCapturedTmuxOutput(
    output: string,
    sidebar?: TmuxCaptureDto["sidebar"]
  ) {
    rememberTmuxScrollPosition();
    setTmuxOutput(output);
    setTmuxSidebar(sidebar);
  }

  function applyCachedTmuxCapture(session: string): boolean {
    const cached = tmuxCaptureCacheRef.current[session];
    if (!cached) {
      return false;
    }
    setCapturedTmuxOutput(cached.output, cached.sidebar);
    return true;
  }

  function applyCachedTmuxCaptureOrClear(session: string): boolean {
    if (applyCachedTmuxCapture(session)) {
      return true;
    }
    setCapturedTmuxOutput("");
    return false;
  }

  function currentTmuxScrollNode() {
    return tmuxOutputRef.current;
  }

  function resolveTmuxCaptureClientWidth(): number {
    return tmuxCaptureWidthRef.current?.clientWidth || currentTmuxScrollNode()?.clientWidth || window.innerWidth || 1280;
  }

  function resolveTmuxCaptureClientHeight(): number {
    return tmuxCaptureWidthRef.current?.clientHeight || currentTmuxScrollNode()?.clientHeight || window.innerHeight || 744;
  }

  function rememberTmuxScrollPosition() {
    const node = currentTmuxScrollNode();
    tmuxScrollSnapshotRef.current = node && !forceTmuxScrollBottomRef.current && !tmuxStickToBottomRef.current
      ? readTmuxScrollSnapshot(node)
      : null;
  }

  function queueTmuxOutputBottomScroll() {
    forceTmuxScrollBottomRef.current = true;
    tmuxStickToBottomRef.current = true;
    setTmuxAtBottom(true);
  }

  function handleTmuxOutputScroll(event: UIEvent<HTMLElement>) {
    updateTmuxBottomState(event.currentTarget);
  }

  function updateTmuxBottomState(node: HTMLElement) {
    const atBottom = node.scrollHeight - node.scrollTop - node.clientHeight < 24;
    tmuxStickToBottomRef.current = atBottom;
    setTmuxAtBottom(atBottom);
  }

  function jumpTmuxOutputToBottom() {
    const node = currentTmuxScrollNode();
    if (!node) {
      return;
    }
    tmuxScrollSnapshotRef.current = null;
    tmuxStickToBottomRef.current = true;
    setTmuxAtBottom(true);
    node.scrollTo({ top: node.scrollHeight, behavior: "smooth" });
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark"><img alt="" src="/agent-tmux-logo.png" /></div>
          <div>
            <h1>Agent Tmux</h1>
            <span>{status?.codex.initialized ? "codex connected" : "tmux ready"}</span>
          </div>
        </div>

        <section className="sidebar-section">
          <div className="section-title">
            <Cpu size={15} />
            Runtime
          </div>
          <label>
            Model
            <select value={model} onChange={(event) => setModel(event.target.value)}>
              {models.map((entry) => (
                <option key={entry.id} value={entry.id}>{entry.displayName}</option>
              ))}
            </select>
          </label>
          <label>
            Reasoning
            <select value={effort} onChange={(event) => setEffort(event.target.value)}>
              {modelEfforts.map((entry) => <option key={entry}>{entry}</option>)}
            </select>
          </label>
          <label>
            Working directory
            <input value={cwd} onChange={(event) => setCwd(event.target.value)} />
          </label>
          <div className="button-row">
            <button type="button" onClick={() => { setThreadId(""); setTimeline([]); setThreadStatus("idle"); }}>
              <Plus size={15} /> New
            </button>
            <button type="button" onClick={() => loadThreads().catch(reportError(setError))}>
              <RefreshCw size={15} /> Threads
            </button>
          </div>
        </section>

        <section className="sidebar-section">
          <div className="section-title">
            <Sparkles size={15} />
            Skills
          </div>
          <input value={skillQuery} onChange={(event) => setSkillQuery(event.target.value)} placeholder="Search skills" />
          <div className="skill-list">
            {filteredSkills.map((skill) => (
              <button key={skill.path} type="button" onClick={() => insertSkillName(skill.name)}>
                <Wrench size={14} />
                <span>{skill.name}</span>
              </button>
            ))}
          </div>
        </section>

        <section className="sidebar-section threads">
          <div className="section-title">
            <Activity size={15} />
            Recent Codex Threads
          </div>
          {threads.slice(0, 10).map((thread) => (
            <button className={thread.id === threadId ? "thread active" : "thread"} key={thread.id} type="button" onClick={() => resumeThread(thread.id).catch(reportError(setError))}>
              <span>{clipText(thread.name || thread.preview || "Untitled thread", 92)}</span>
              <small>{thread.cwd}</small>
            </button>
          ))}
        </section>
      </aside>

      <main className="main">
        <header className="topbar">
          <div>
            <div className="eyeline">
              <span className={status?.codex.connected ? "dot online" : "dot"} />
              {baseUrl || "loading URL"}
            </div>
            <h2>{threadId ? `Thread ${threadId.slice(0, 8)}` : "Tmux agent session"}</h2>
          </div>
          <div className="top-actions">
            <span className="status-pill">{threadStatus}</span>
            <button type="button" onClick={() => interruptTurn().catch(reportError(setError))}>
              <CircleStop size={16} /> Stop
            </button>
          </div>
        </header>

        {error && <div className="error">{error}</div>}

        <div ref={scrollerRef} className="timeline">
          {timeline.length === 0 ? (
            <div className="empty-state">
              <TerminalIcon size={30} />
              <h3>Start an agent turn</h3>
              <p>Messages can run through the optional Codex app-server, or use tmux for any terminal agent CLI.</p>
            </div>
          ) : (
            timeline.map((entry) => <TimelineCard key={entry.id} entry={entry} />)
          )}
        </div>

        <form className="composer" onSubmit={(event) => sendMessage(event).catch(reportError(setError))}>
          <textarea
            ref={composerRef}
            value={message}
            onChange={(event) => {
              setMessage(event.target.value);
              setComposerCaret(event.target.selectionStart);
            }}
            onClick={(event) => setComposerCaret(event.currentTarget.selectionStart)}
            onKeyDown={handleComposerKeyDown}
            onKeyUp={(event) => setComposerCaret(event.currentTarget.selectionStart)}
            onPaste={handleComposerPaste}
            onSelect={(event) => setComposerCaret(event.currentTarget.selectionStart)}
            placeholder="Ask an agent to work in this repo..."
          />
          {slashQuery && slashMatches.length > 0 && (
            <div className="slash-menu" role="listbox" aria-label="Slash commands">
              {slashMatches.map((command, index) => (
                <button
                  key={command.name}
                  className={index === slashIndex ? "active" : ""}
                  type="button"
                  role="option"
                  aria-selected={index === slashIndex}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    chooseSlashCommand(command);
                  }}
                >
                  <strong>{command.name}</strong>
                  <span>{command.description}</span>
                </button>
              ))}
            </div>
          )}
          <button
            aria-label={uploadingComposerFiles ? "Uploading pasted image" : "Send message"}
            disabled={uploadingComposerFiles}
            title={uploadingComposerFiles ? "Uploading pasted image" : "Send message"}
            type="submit"
          >
            <Send size={18} />
          </button>
        </form>
      </main>

      <aside className="tmux-panel">
        <div className="tmux-app-toolbar">
          <div className="tmux-compact-bar">
            <div className="tmux-title">
              <img alt="" src="/agent-tmux-logo.png" />
              Agent Tmux
              <EnvironmentBadge environment={status?.environment} />
            </div>
            <button className="tmux-session-menu-button" type="button" onClick={() => setTmuxMenuOpen((current) => !current)}>
              <span>{selectedTmuxEntry ? tmuxPaneDisplayName(selectedTmuxEntry) : selectedTmux || "no session"}</span>
              <Menu size={15} />
            </button>
          </div>
          <div className={`tmux-terminal-toolbar ${windowSnoozeAvailable ? "with-snooze" : ""}`}>
            <button
              aria-label={`Switch to ${terminalActive ? "TTY" : "Raw"} view`}
              className="tmux-view-toggle"
              disabled={!selectedTmux}
              title={`Switch to ${terminalActive ? "TTY" : "Raw"} view`}
              type="button"
              onClick={() => selectTmuxViewMode(terminalActive ? "tty" : "raw")}
            >
              {terminalActive ? <Keyboard aria-hidden="true" size={15} /> : <Monitor aria-hidden="true" size={15} />}
              <span>{tmuxViewModeLabel}</span>
            </button>
            <button
              aria-label="Stop tmux task"
              disabled={!selectedTmux}
              title="Stop tmux task (Esc or Ctrl-C)"
              type="button"
              onClick={() => interruptTmux().catch(reportError(setError))}
            >
              <CircleStop aria-hidden="true" size={15} />
            </button>
            <button
              aria-label={selectedTmuxPinned ? "Unpin this pane" : "Pin this pane"}
              aria-pressed={selectedTmuxPinned}
              className={selectedTmuxPinned ? "active" : ""}
              disabled={!selectedTmux}
              title={selectedTmuxPinned ? "Unpin this pane" : "Pin this pane to the top of the list"}
              type="button"
              onClick={() => toggleTmuxSessionPin(selectedTmux)}
            >
              <Pin aria-hidden="true" fill={selectedTmuxPinned ? "currentColor" : "none"} size={15} />
            </button>
            <button
              aria-label="Refresh sessions and current view"
              aria-busy={manualCaptureActive}
              disabled={manualCaptureActive}
              title="Refresh sessions and current view"
              type="button"
              onClick={refreshTmux}
            >
              <RefreshCw size={15} /> <span>Refresh</span>
            </button>
            <button
              aria-label="Close pane"
              className="tmux-close-pane-button"
              disabled={!selectedTmuxEntry?.paneId}
              title="Close pane (kills its process)"
              type="button"
              onClick={() => closeSelectedTmuxPane().catch(reportError(setError))}
            >
              <SquareX aria-hidden="true" size={15} />
            </button>
            {windowSnoozeAvailable && (
              <button
                aria-label="Snooze this pane's window"
                disabled={!selectedTmuxSnoozable}
                title="Snooze window: hide it until a wake time"
                type="button"
                onClick={openWindowSnoozeSheet}
              >
                <AlarmClock aria-hidden="true" size={15} />
              </button>
            )}
            <span className="tmux-terminal-status">{formatTmuxStatusText(terminalStatus || selectedTmux || "no session selected", tmuxSessions)}</span>
            <details className="tmux-view-menu tmux-settings-menu" ref={tmuxSettingsMenuRef}>
              <summary aria-label="More options" title="More options">
                <Ellipsis aria-hidden="true" size={16} />
              </summary>
              <div className="tmux-view-menu-content tmux-settings-menu-content" role="menu">
                <div className="tmux-view-menu-section tmux-settings-actions">
                  <span>Panes</span>
                  <button
                    aria-checked={showAllTmuxPanes}
                    className={showAllTmuxPanes ? "active" : ""}
                    role="menuitemcheckbox"
                    type="button"
                    onClick={toggleShowAllTmuxPanes}
                  >
                    {showAllTmuxPanes ? <Eye size={15} /> : <EyeOff size={15} />}
                    <span>Show all panes{hiddenTmuxPaneCount > 0 && !showAllTmuxPanes ? ` (${hiddenTmuxPaneCount} hidden)` : ""}</span>
                  </button>
                  <button
                    aria-checked={tmuxNotificationsEnabled}
                    className={tmuxNotificationsEnabled ? "active" : ""}
                    role="menuitemcheckbox"
                    type="button"
                    onClick={() => toggleTmuxNotifications().catch(reportError(setError))}
                  >
                    {tmuxNotificationsEnabled ? <Bell size={15} /> : <BellOff size={15} />}
                    <span>Browser notifications</span>
                  </button>
                </div>
                <div className="tmux-view-menu-section">
                  <span>Theme</span>
                  <div className="tmux-settings-options two-column">
                    <button className={colorTheme === "light" ? "active" : ""} role="menuitemradio" aria-checked={colorTheme === "light"} type="button" onClick={() => selectColorTheme("light")}>
                      <Sun size={15} />
                      <span>Light</span>
                    </button>
                    <button className={colorTheme === "dark" ? "active" : ""} role="menuitemradio" aria-checked={colorTheme === "dark"} type="button" onClick={() => selectColorTheme("dark")}>
                      <Moon size={15} />
                      <span>Dark</span>
                    </button>
                  </div>
                </div>
                <div className="tmux-view-menu-section">
                  <span>Default view</span>
                  <div className="tmux-settings-options two-column">
                    {(Object.keys(TMUX_VIEW_MODE_LABELS) as TmuxViewMode[]).map((mode) => (
                      <button className={defaultTmuxViewMode === mode ? "active" : ""} role="menuitemradio" aria-checked={defaultTmuxViewMode === mode} type="button" key={mode} onClick={() => selectDefaultTmuxViewMode(mode)}>
                        {mode === "tty" ? <TerminalIcon size={14} /> : <Keyboard size={14} />}
                        <span>{TMUX_VIEW_MODE_LABELS[mode]}</span>
                      </button>
                    ))}
                  </div>
                </div>
                <div className="tmux-view-menu-section">
                  <span>When switching sessions</span>
                  <div className="tmux-settings-policy-options">
                    <button className={tmuxViewSwitchPolicy === "remember" ? "active" : ""} role="menuitemradio" aria-checked={tmuxViewSwitchPolicy === "remember"} type="button" onClick={() => selectTmuxViewSwitchPolicy("remember")}>
                      <Check size={16} />
                      <span className="tmux-settings-option-copy"><strong>Remember per session</strong><small>Return to each session's last view</small></span>
                    </button>
                    <button className={tmuxViewSwitchPolicy === "default" ? "active" : ""} role="menuitemradio" aria-checked={tmuxViewSwitchPolicy === "default"} type="button" onClick={() => selectTmuxViewSwitchPolicy("default")}>
                      <RefreshCw size={16} />
                      <span className="tmux-settings-option-copy"><strong>Use default</strong><small>Reset the view whenever you switch</small></span>
                    </button>
                  </div>
                </div>
                <div className="tmux-view-menu-section tmux-settings-actions">
                  <span>Connection</span>
                  <button role="menuitem" type="button" onClick={() => copyServerUrl().catch(reportError(setError))}>
                    <Copy size={15} />
                    <span>Copy server URL</span>
                  </button>
                </div>
                {androidConnectionSettingsAvailable && (
                  <div className="tmux-view-menu-section">
                    <span>App</span>
                    <button role="menuitem" type="button" onClick={showAndroidConnectionSettings}>
                      <Wrench size={15} />
                      <span>Connection settings</span>
                    </button>
                  </div>
                )}
              </div>
            </details>
          </div>
        </div>
        <div className="tmux-control-rail">
          <div className={tmuxMenuOpen ? "tmux-menu open" : "tmux-menu"}>
            {!demoMode && (
              <button className="tmux-new-agent-button" type="button" onClick={() => setNewAgentOpen(true)}>
                <Bot aria-hidden="true" size={15} /> <span>New agent</span>
              </button>
            )}
            <div className="tmux-rail-section-title">Sessions</div>
            <TmuxSessionList
              groupPreferences={tmuxSessionGroupPreferences}
              paneViews={tmuxPaneViews}
              panes={railTmuxPanes}
              pinnedNames={pinnedTmuxSessionNames}
              selected={selectedTmux}
              onSelect={selectTmuxSession}
              onTogglePin={toggleTmuxSessionPin}
              onToggleGroup={setTmuxSessionGroupCollapsedPreference}
              onWake={windowSnoozeAvailable ? (name) => wakeTmuxWindow(name).catch(reportError(setError)) : undefined}
            />
          </div>
          <div className="tmux-connection-status">
            <span className={status?.tailscaleDns || status?.tailscaleIp ? "dot online" : "dot"} />
            <span>{status?.tailscaleDns || status?.tailscaleIp ? "Tailscale connected" : "Local service"}</span>
          </div>
        </div>
        <div className="tmux-workspace">
          <div className="tmux-output-shell" ref={tmuxCaptureWidthRef}>
            {!selectedTmux ? (
              <div className="tmux-empty-session" role="status">
                <TerminalIcon size={26} />
                <strong>No tmux session selected</strong>
                <span>Start a New agent or choose a pane from the session list.</span>
              </div>
            ) : terminalActive ? (
              <div
                ref={terminalHostRef}
                aria-label="Raw interactive tmux terminal"
                className="tmux-terminal"
                role="application"
              />
            ) : (
              <TmuxTtyView
                key={`${selectedTmux}-${tmuxSidebar?.kind ?? "terminal"}`}
                ref={tmuxOutputRef}
                onScroll={handleTmuxOutputScroll}
                output={tmuxOutput}
                sidebar={tmuxSidebar}
                theme={colorTheme}
              />
            )}
            {showTmuxJumpToLatest && (
              <button className={`tmux-jump-bottom${tmuxSidebar ? " stream-pane" : ""}`} aria-label="Jump to latest tmux output" title="Jump to latest tmux output" type="button" onClick={jumpTmuxOutputToBottom}>
                <ArrowDownToLine size={17} />
              </button>
            )}
          </div>
          {showTmuxKeyStrip && (
            <TmuxKeyStrip armed={armedKeyModifier} onKey={pressKeyStripKey} onToggleModifier={toggleArmedKeyModifier} />
          )}
          {showTmuxSendForm && (
            <form className="tmux-send" onSubmit={(event) => { event.preventDefault(); sendTmux().catch(reportError(setError)); }}>
              <button
                aria-label="Attach files"
                disabled={uploadingTmuxFiles}
                title="Upload files and insert safe attachment references"
                type="button"
                onClick={() => tmuxFileInputRef.current?.click()}
              >
                <Paperclip size={15} />
              </button>
              <input
                ref={tmuxFileInputRef}
                className="tmux-file-input"
                multiple
                type="file"
                onChange={(event) => {
                  const input = event.currentTarget;
                  attachTmuxFiles(input.files).catch(reportError(setError)).finally(() => {
                    input.value = "";
                  });
                }}
              />
              <textarea
                ref={tmuxInputRef}
                rows={1}
                value={tmuxInput}
                onChange={(event) => {
                  // iOS fallback when keydown/beforeinput could not intercept: leaving state alone reverts the text.
                  const typed = armedKeyModifierRef.current ? insertedCharacter(tmuxInput, event.target.value) : null;
                  if (typed && consumeArmedKey(typed)) {
                    return;
                  }
                  setTmuxInput(event.target.value);
                  resizeTmuxInput(event.currentTarget);
                }}
                onKeyDown={handleTmuxInputKeyDown}
                onPaste={handleTmuxInputPaste}
                placeholder="send keys + Enter"
              />
              <button aria-label="Send to tmux" title="Send to tmux" type="submit"><Play size={15} /></button>
            </form>
          )}
        </div>
      </aside>
      {windowSnoozeEntry && (
        <WindowSnoozeSheet
          paneName={tmuxPaneDisplayName(windowSnoozeEntry)}
          snoozedUntilMs={windowSnoozeEntry.snoozedUntilMs}
          snooze={(duration) => snoozeTmuxWindow(windowSnoozeEntry.name, duration)}
          wake={() => wakeTmuxWindow(windowSnoozeEntry.name)}
          onClose={() => setWindowSnoozeTarget("")}
        />
      )}
      {newAgentOpen && (
        <NewAgentSheet
          loadAgents={loadNewAgentOptions}
          startAgent={startNewAgent}
          onClose={() => setNewAgentOpen(false)}
          onStarted={handleAgentStarted}
        />
      )}
    </div>
  );
}

function loadNewAgentOptions(): Promise<AgentsDto> {
  return api<{ data: AgentsDto }>("/api/tmux/agents").then((result) => result.data);
}

function startNewAgent(agent: string, cwd: string): Promise<StartAgentResultDto> {
  return api<{ data: StartAgentResultDto }>("/api/tmux/agents/start", {
    method: "POST",
    body: JSON.stringify({ agent, cwd })
  }).then((result) => result.data);
}

function TimelineCard({ entry }: { entry: TimelineEntry }) {
  return (
    <article className={`timeline-card ${entry.kind}`}>
      <div className="timeline-card-header">
        <strong>{entry.title}</strong>
        {entry.status && <span>{entry.status}</span>}
      </div>
      <pre>{entry.body ? <LinkifiedText text={entry.body} /> : " "}</pre>
    </article>
  );
}

function resolveTmuxCapture(result: TmuxCaptureDto, previous?: CachedTmuxCapture): CachedTmuxCapture {
  const reuseOutput = result.outputUnchanged
    && result.outputRevision === previous?.outputRevision;
  const appendOutput = result.outputAppend
    && result.outputRevision !== previous?.outputRevision
    && Boolean(previous?.outputRevision);
  return {
    output: reuseOutput
      ? previous?.output ?? result.output
      : appendOutput
        ? `${previous?.output ?? ""}${result.output}`
        : result.output,
    outputRevision: result.outputRevision,
    sidebar: result.sidebar
  };
}

function sameTmuxCaptureContent(left: CachedTmuxCapture | undefined, right: CachedTmuxCapture): boolean {
  return left?.output === right.output
    && left.sidebar?.kind === right.sidebar?.kind
    && left.sidebar?.output === right.sidebar?.output;
}

async function api<T = unknown>(url: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (!headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  const token = browserAccessToken();
  if (token && !headers.has("x-agent-tmux-web-token")) {
    headers.set("x-agent-tmux-web-token", token);
  }

  const response = await fetch(url, {
    ...init,
    headers
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(body || response.statusText);
  }
  return response.json() as Promise<T>;
}

async function uploadFileToServer(file: File): Promise<UploadedFileDto> {
  const query = new URLSearchParams({ filename: file.name || "upload" });
  const headers = new Headers({
    "content-type": file.type || "application/octet-stream"
  });
  const token = browserAccessToken();
  if (token) {
    headers.set("x-agent-tmux-web-token", token);
  }

  const response = await fetch(`/api/uploads?${query}`, {
    method: "POST",
    headers,
    body: file
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(body || response.statusText);
  }
  const result = await response.json() as { file: UploadedFileDto };
  return result.file;
}

function browserAccessToken(): string {
  return initialAccessToken;
}

async function hasCookieSession(): Promise<boolean> {
  const response = await fetch("/api/auth/session", { credentials: "same-origin" });
  return response.ok;
}

function readInitialRequestedTmuxSession(): string {
  return typeof window === "undefined" ? "" : readRequestedTmuxSession(window.location.search);
}

function clearRequestedTmuxSessionFromAddressBar() {
  if (typeof window === "undefined") {
    return;
  }
  const current = new URL(window.location.href);
  const next = removeRequestedTmuxSession(current);
  if (next !== window.location.href) {
    window.history.replaceState(window.history.state, "", next);
  }
}

function readTmuxScrollSnapshot(node: HTMLElement): TmuxScrollSnapshot {
  const anchor = findFirstVisibleTmuxAnchor(node);
  const nodeTop = node.getBoundingClientRect().top;
  return {
    anchorIndex: anchor ? readTmuxAnchorIndex(anchor) : 0,
    anchorOffsetTop: anchor ? anchor.getBoundingClientRect().top - nodeTop : 0,
    anchorText: anchor?.textContent ?? "",
    scrollTop: node.scrollTop
  };
}

function restoreTmuxScrollSnapshot(node: HTMLElement, snapshot: TmuxScrollSnapshot): void {
  const anchor = findMatchingTmuxAnchor(node, snapshot);
  if (anchor) {
    const currentOffsetTop = anchor.getBoundingClientRect().top - node.getBoundingClientRect().top;
    node.scrollTop += currentOffsetTop - snapshot.anchorOffsetTop;
    return;
  }

  const maxScrollTop = Math.max(0, node.scrollHeight - node.clientHeight);
  node.scrollTop = Math.min(snapshot.scrollTop, maxScrollTop);
}

function findFirstVisibleTmuxAnchor(node: HTMLElement): HTMLElement | null {
  const anchors = Array.from(node.querySelectorAll<HTMLElement>(TMUX_SCROLL_ANCHOR_SELECTOR));
  if (anchors.length === 0) {
    return null;
  }

  const nodeRect = node.getBoundingClientRect();
  const visible = anchors.filter((anchor) => {
    const anchorRect = anchor.getBoundingClientRect();
    return anchorRect.bottom > nodeRect.top && anchorRect.top < nodeRect.bottom;
  });
  return visible.find((anchor) => anchor.textContent?.trim()) ?? visible[0] ?? anchors[0] ?? null;
}

function findMatchingTmuxAnchor(node: HTMLElement, snapshot: TmuxScrollSnapshot): HTMLElement | null {
  const anchors = Array.from(node.querySelectorAll<HTMLElement>(TMUX_SCROLL_ANCHOR_SELECTOR));
  const matching = anchors.filter((anchor) => (anchor.textContent ?? "") === snapshot.anchorText);
  if (matching.length === 0) {
    return null;
  }
  return matching.sort((left, right) => (
    Math.abs(readTmuxAnchorIndex(left) - snapshot.anchorIndex)
      - Math.abs(readTmuxAnchorIndex(right) - snapshot.anchorIndex)
  ))[0] ?? null;
}

function readTmuxAnchorIndex(anchor: HTMLElement): number {
  const parsed = Number(anchor.dataset.tmuxAnchorIndex);
  return Number.isFinite(parsed) ? parsed : 0;
}

function sendTerminalSocketInput(socket: WebSocket, data: string): void {
  for (let index = 0; index < data.length; index += RAW_TERMINAL_INPUT_CHUNK_SIZE) {
    socket.send(JSON.stringify({ type: "input", data: data.slice(index, index + RAW_TERMINAL_INPUT_CHUNK_SIZE) }));
  }
}

function readInitialColorTheme(): ColorTheme {
  if (typeof window === "undefined") {
    return "dark";
  }
  let storedTheme: string | null = null;
  try {
    storedTheme = window.localStorage.getItem(COLOR_THEME_STORAGE_KEY);
  } catch {
    storedTheme = null;
  }
  const prefersLight = window.matchMedia?.("(prefers-color-scheme: light)").matches ?? false;
  return resolveInitialColorTheme(storedTheme, prefersLight);
}

function readInitialPinnedTmuxSessionNames(): string[] {
  return parsePinnedTmuxSessionNames(readStoredValue(PINNED_TMUX_SESSIONS_STORAGE_KEY));
}

function readInitialTmuxSessionGroupPreferences(): TmuxSessionGroupPreferences {
  return parseTmuxSessionGroupPreferences(readStoredValue(TMUX_SESSION_GROUPS_STORAGE_KEY));
}

function readInitialTmuxPaneViews(): TmuxPaneViews {
  const stored = readStoredValue(TMUX_PANE_VIEWS_STORAGE_KEY);
  const views = parseTmuxPaneViews(stored, Date.now());
  if (!stored) {
    // First run: only output from now on counts as new.
    writeStoredJson(TMUX_PANE_VIEWS_STORAGE_KEY, views);
  }
  return views;
}

function readInitialShowAllTmuxPanes(): boolean {
  return readStoredValue(SHOW_ALL_TMUX_PANES_STORAGE_KEY) === "1";
}

function readInitialDefaultTmuxViewMode(): TmuxViewMode {
  return normalizeTmuxViewMode(readStoredValue(DEFAULT_TMUX_VIEW_STORAGE_KEY)) ?? FALLBACK_TMUX_VIEW_MODE;
}

function readInitialTmuxViewSwitchPolicy(): TmuxViewSwitchPolicy {
  return normalizeTmuxViewSwitchPolicy(readStoredValue(TMUX_VIEW_SWITCH_POLICY_STORAGE_KEY)) ?? FALLBACK_TMUX_VIEW_SWITCH_POLICY;
}

function readInitialTmuxSessionViewModes(): Record<string, TmuxViewMode> {
  return parseTmuxSessionViewModes(readStoredValue(TMUX_SESSION_VIEWS_STORAGE_KEY));
}

function readStoredValue(key: string): string | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStoredJson(key: string, value: unknown) {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Some private browser modes block localStorage; in-memory preferences still apply.
  }
}

function writeStoredValue(key: string, value: string) {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Some private browser modes block localStorage; in-memory preferences still apply.
  }
}

function writeColorThemePreference(theme: ColorTheme) {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(COLOR_THEME_STORAGE_KEY, theme);
  } catch {
    // Some private browser modes block localStorage; the in-memory theme still applies.
  }
}

function terminalThemeForColorTheme(theme: ColorTheme) {
  return theme === "light"
    ? {
      background: "#ffffff",
      foreground: "#172026",
      cursor: "#087f6b",
      selectionBackground: "#b7e4d8"
    }
    : {
      background: "#0d0f10",
      foreground: "#d8dee2",
      cursor: "#54b399",
      selectionBackground: "#2f6f5f"
    };
}

function readTmuxNotificationPreference(): boolean {
  try {
    const stored = window.localStorage.getItem(TMUX_NOTIFICATION_STORAGE_KEY) === "1";
    return stored && (getBrowserNotificationSnapshot().androidBridge || canShowBrowserNotifications());
  } catch {
    return false;
  }
}

function writeTmuxNotificationPreference(enabled: boolean) {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(TMUX_NOTIFICATION_STORAGE_KEY, enabled ? "1" : "0");
  } catch {
    // Some private browser modes block localStorage; notification permission still applies.
  }
}

function showTmuxNotification(event: TmuxWatchEvent, displayName?: string) {
  const notification = buildTmuxTransitionNotification(event.session, event.label, event.state, displayName);
  showAgentNotification(
    notification.title,
    notification.body,
    notification.tag,
    { tmuxSession: notification.tmuxSession }
  );
}

function describeTerminalKey(data: string): string {
  if (data === "\x1b") return "Esc";
  if (data === "\t") return "Tab";
  if (data === "\x03") return "Ctrl-C";
  if (data === "\x04") return "Ctrl-D";
  if (data === "\x0c") return "Ctrl-L";
  if (data === "\r") return "Enter";
  if (data === "\x1b[A") return "Up";
  if (data === "\x1b[B") return "Down";
  if (data === "\x1b[C") return "Right";
  if (data === "\x1b[D") return "Left";
  return "key";
}

function handleWsPayload(
  payload: WsPayload,
  setStatus: React.Dispatch<React.SetStateAction<AppStatus | null>>,
  setThreadStatus: (status: string) => void,
  setTimeline: React.Dispatch<React.SetStateAction<TimelineEntry[]>>,
  setActiveTurnId: (turnId: string) => void
) {
  if (payload.type === "hello") {
    if (isAppStatus(payload.status)) {
      setStatus(payload.status);
    }
    payload.recentEvents?.forEach((event) => handleWsPayload(event, setStatus, setThreadStatus, setTimeline, setActiveTurnId));
    return;
  }

  if (payload.type === "codex-status") {
    const codexStatus = isCodexStatus(payload.status) ? payload.status : null;
    if (codexStatus) {
      setStatus((current) => current ? {
        ...current,
        codex: {
          ...current.codex,
          ...codexStatus
        }
      } : current);
    }
    return;
  }

  const description = payload.description;
  if (!description) {
    return;
  }

  if (description.turnId) {
    setActiveTurnId(description.turnId);
  }
  if (description.kind === "status" && description.status) {
    setThreadStatus(clipText(description.status, 42));
  }

  setTimeline((entries) => applyDescription(entries, description));
}

function isAppStatus(value: unknown): value is AppStatus {
  return Boolean(value && typeof value === "object" && "bindHost" in value && "codex" in value);
}

function EnvironmentBadge({ environment }: { environment?: AppStatus["environment"] }) {
  if (!environment) {
    return null;
  }
  return <span className={`environment-badge ${environment}`}>{environment === "development" ? "DEV" : "PROD"}</span>;
}

function isCodexStatus(value: unknown): value is Partial<AppStatus["codex"]> {
  return Boolean(value && typeof value === "object" && ("connected" in value || "initialized" in value || "lastError" in value));
}

function isTmuxWatchEvent(value: unknown): value is TmuxWatchEvent {
  return Boolean(
    value
    && typeof value === "object"
    && typeof (value as Record<string, unknown>).id === "number"
    && typeof (value as Record<string, unknown>).session === "string"
    && typeof (value as Record<string, unknown>).label === "string"
    && ((value as Record<string, unknown>).state === "waiting-for-input" || (value as Record<string, unknown>).state === "idle")
    && typeof (value as Record<string, unknown>).revision === "number"
  );
}

function applyDescription(entries: TimelineEntry[], description: UiEventDescription): TimelineEntry[] {
  if (description.kind === "unknown" && !description.threadId && !description.itemId) {
    return entries;
  }

  const id = description.itemId || `${description.kind}-${Date.now()}-${Math.random()}`;

  if (description.kind.endsWith("delta") || description.kind === "tool-output") {
    const title = description.kind === "assistant-delta" ? "Agent" : description.kind === "reasoning-delta" ? "Reasoning" : description.kind === "plan-delta" ? "Plan" : "Shell Output";
    return appendEntry(entries, id, {
      kind: description.kind,
      title,
      body: description.text ?? "",
      status: description.status
    });
  }

  if (description.kind === "item-started") {
    return upsertEntry(entries, id, {
      id,
      kind: description.kind,
      title: description.title ?? "Started",
      body: description.body ?? "",
      status: description.status
    });
  }

  if (description.kind === "item-completed") {
    return upsertEntry(entries, id, {
      id,
      kind: description.kind,
      title: description.title ?? "Completed",
      body: description.body ?? "",
      status: description.status || "completed"
    }, true);
  }

  return [
    ...entries,
    {
      id,
      kind: description.kind,
      title: description.title ?? description.kind,
      body: description.body ?? description.text ?? "",
      status: description.status
    }
  ];
}

function appendEntry(entries: TimelineEntry[], id: string, patch: Omit<TimelineEntry, "id">): TimelineEntry[] {
  const index = entries.findIndex((entry) => entry.id === id);
  if (index === -1) {
    return [...entries, { id, ...patch }];
  }

  return entries.map((entry, entryIndex) => entryIndex === index ? { ...entry, body: `${entry.body}${patch.body}`, status: patch.status ?? entry.status } : entry);
}

function upsertEntry(entries: TimelineEntry[], id: string, next: TimelineEntry, preserveBody = false): TimelineEntry[] {
  const index = entries.findIndex((entry) => entry.id === id);
  if (index === -1) {
    return [...entries, next];
  }
  return entries.map((entry, entryIndex) => entryIndex === index ? { ...entry, ...next, body: preserveBody && entry.body ? entry.body : next.body } : entry);
}

function addUserEntry(setTimeline: React.Dispatch<React.SetStateAction<TimelineEntry[]>>, text: string) {
  setTimeline((entries) => [
    ...entries,
    {
      id: `user-${Date.now()}`,
      kind: "user",
      title: "You",
      body: text
    }
  ]);
}

function addLocalEntry(setTimeline: React.Dispatch<React.SetStateAction<TimelineEntry[]>>, title: string, body: string) {
  setTimeline((entries) => [
    ...entries,
    {
      id: `local-${Date.now()}-${Math.random()}`,
      kind: "local",
      title,
      body
    }
  ]);
}

function clearTmuxFollowTimers(ref: React.MutableRefObject<number[]>) {
  for (const timer of ref.current) {
    window.clearTimeout(timer);
  }
  ref.current = [];
}

function parseTerminalSocketMessage(data: unknown): Record<string, unknown> | null {
  if (typeof data !== "string") {
    return null;
  }
  try {
    const parsed = JSON.parse(data) as unknown;
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function threadToEntries(turns: Array<{ items: unknown[] }>): TimelineEntry[] {
  return turns.flatMap((turn) =>
    turn.items.map((item, index) => {
      const record = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
      const summary = describeThreadItem(record);
      return {
        id: String(record.id ?? `${index}-${summary.title}`),
        kind: summary.kind,
        title: summary.title,
        body: summary.body,
        status: summary.status
      };
    })
  );
}

function reportError(setError: (message: string) => void) {
  return (error: unknown) => {
    setError(error instanceof Error ? error.message : String(error));
  };
}

function clipText(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}...` : value;
}
