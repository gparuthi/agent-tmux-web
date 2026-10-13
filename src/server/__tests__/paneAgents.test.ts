import { afterEach, describe, expect, it, vi } from "vitest";

import {
  detectTmuxPaneAgents,
  findProcessTreeAgent,
  parseProcessTable,
  processArgsAgent,
  readCachedProcessTable,
  resetProcessTableCache
} from "../paneAgents.js";

// `ps -A -o pid=,ppid=,args=` as seen on the owner's Mac, trimmed to the panes under test.
const PS_FIXTURE = [
  "    1     0 /sbin/launchd",
  " 1559     1 tmux new-session -d -s main",
  // codex resumed through the login shell: zsh -> node codex -> native codex -> its own helpers.
  "22974  1559 zsh -ic codex resume 01a104f8; exec zsh",
  "23103 22974 node /opt/homebrew/bin/codex resume 01a104f8",
  "23108 23103 /opt/homebrew/lib/node_modules/@openai/codex/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex resume 01a104f8",
  // Claude Code sets its process title to its version number.
  " 1763  1559 -zsh",
  " 2362  1763 2.1.289",
  // Claude running codex as a tool must still read as claude.
  " 1786  1559 -zsh",
  " 2338  1786 claude -r 8bf3df3b",
  "61314  2338 /bin/zsh -c codex exec 'review'",
  "61315 61314 node /opt/homebrew/bin/codex exec review",
  // pi installed as ~/.local/bin/pi -> ~/.pi/agent/bin/pi, which execs the release under node.
  " 3001  1559 /bin/zsh -lic /Users/me/.local/bin/pi; exec /bin/zsh -l",
  " 3002  3001 node /Users/me/.pi/agent/install/releases/0.9.1/node_modules/.bin/pi",
  // opencode run as a bun script.
  " 4001  1559 -zsh",
  " 4002  4001 bun run /Users/me/.bun/install/global/node_modules/opencode-ai/bin/opencode.js",
  // Plain shell, a shell running a non-agent node script, and a shell whose codex has exited.
  " 5001  1559 -zsh",
  " 5101  1559 -zsh",
  " 5102  5101 node --no-warnings /Users/me/work/site/server.js",
  " 6001  1559 zsh -ic codex resume 02b2; exec zsh",
  // hax is a native binary; the shell running its bash tool is not the agent.
  " 7001  1559 -zsh",
  " 7002  7001 /opt/homebrew/bin/hax --provider=codex",
  " 7003  7002 /bin/bash -c sleep 8; ls",
  ""
].join("\n");

const table = parseProcessTable(PS_FIXTURE);

afterEach(() => {
  resetProcessTableCache();
});

describe("pane agents from the process tree", () => {
  it("finds codex under node when tmux only reports node", () => {
    expect(findProcessTreeAgent(table, 22974)).toBe("codex");
    expect(detectTmuxPaneAgents([{ name: "%27", paneId: "%27", panePid: 22974, currentCommand: "node" }], table))
      .toEqual(new Map([["%27", "codex"]]));
  });

  it("recognises claude by its version-number title and wins over agents it spawns", () => {
    expect(findProcessTreeAgent(table, 1763)).toBe("claude");
    expect(findProcessTreeAgent(table, 1786)).toBe("claude");
  });

  it("follows pi through its symlinked launcher to the node script", () => {
    expect(findProcessTreeAgent(table, 3001)).toBe("pi");
  });

  it("finds hax by its binary name", () => {
    expect(findProcessTreeAgent(table, 7001)).toBe("hax");
    expect(processArgsAgent("hax -c")).toBe("hax");
    // Ctrl-T opens the transcript in less; the tree still names the pane hax.
    expect(detectTmuxPaneAgents([{ name: "%9", paneId: "%9", panePid: 7001, currentCommand: "less" }], table))
      .toEqual(new Map([["%9", "hax"]]));
  });

  it("reads the script of a bun run", () => {
    expect(findProcessTreeAgent(table, 4001)).toBe("opencode");
  });

  it("ignores plain shells, other node scripts, and a wrapper whose agent exited", () => {
    expect(findProcessTreeAgent(table, 5001)).toBeNull();
    expect(findProcessTreeAgent(table, 5101)).toBeNull();
    // The wrapper's `-c "codex ..."` text is not a live codex.
    expect(findProcessTreeAgent(table, 6001)).toBeNull();
    expect(findProcessTreeAgent(table, 99999)).toBeNull();
  });

  it("stops at the depth bound", () => {
    expect(findProcessTreeAgent(table, 22974, 0)).toBeNull();
    expect(findProcessTreeAgent(table, 22974, 1)).toBe("codex");
  });

  it("matches argv[0] or an interpreter's script, never other arguments", () => {
    expect(processArgsAgent("/Users/me/.local/bin/claude --resume x")).toBe("claude");
    expect(processArgsAgent("/opt/homebrew/bin/opencode")).toBe("opencode");
    expect(processArgsAgent("python3.12 /Users/me/bin/pi.py")).toBe("pi");
    expect(processArgsAgent("deno run -A /x/codex.ts")).toBe("codex");
    expect(processArgsAgent("node")).toBeNull();
    expect(processArgsAgent("vim codex")).toBeNull();
    expect(processArgsAgent("zsh -ic claude")).toBeNull();
  });

  it("uses tmux's command for shim panes and when ps is unavailable", () => {
    const panes = [
      { name: "dk--box--%3", paneId: "%3", panePid: 22974, currentCommand: "node" },
      { name: "dk--box--%4", paneId: "%4", panePid: 1763, currentCommand: "2.1.289" },
      { name: "%5", paneId: "%5", panePid: 3001, currentCommand: "pi" },
      { name: "%6", paneId: "%6", panePid: 5001, currentCommand: "zsh" },
      { name: "dk--box--%7", paneId: "%7", panePid: 7001, currentCommand: "hax" }
    ];
    expect(detectTmuxPaneAgents(panes, table)).toEqual(new Map([["dk--box--%4", "claude"], ["%5", "pi"], ["dk--box--%7", "hax"]]));
    expect(detectTmuxPaneAgents(panes, null)).toEqual(new Map([["dk--box--%4", "claude"], ["%5", "pi"], ["dk--box--%7", "hax"]]));
  });
});

describe("process table cache", () => {
  it("runs ps once per two seconds and treats a failure as no table", async () => {
    const read = vi.fn(async () => table);
    expect(await readCachedProcessTable(10_000, read)).toBe(table);
    expect(await readCachedProcessTable(11_999, read)).toBe(table);
    expect(read).toHaveBeenCalledTimes(1);
    await readCachedProcessTable(12_000, read);
    expect(read).toHaveBeenCalledTimes(2);

    resetProcessTableCache();
    expect(await readCachedProcessTable(20_000, async () => { throw new Error("ps failed"); })).toBeNull();
  });
});
