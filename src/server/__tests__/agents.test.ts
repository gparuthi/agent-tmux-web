import { execFile, spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  agentRenamesAfterLaunch,
  AgentRequestError,
  buildAgentDefinitions,
  buildAgentShellArgv,
  buildAgentWindowName,
  buildNewAgentTmuxArgs,
  findAgentDefinition,
  findGitRepos,
  listAgentDirectories,
  listAvailableAgents,
  mergeAgentDirectories,
  resolveAgentDirectory,
  sanitizeNewAgentName,
  startAgentInTmux,
  agentBinaryDirs,
  shellQuote,
  type AvailableAgent
} from "../agents.js";

const execFileAsync = promisify(execFile);

const tempDirs: string[] = [];

async function makeTempDir(prefix = "atw-agents-"): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function makeExecutable(filePath: string, body = "#!/bin/sh\nexit 0\n"): Promise<string> {
  await writeFile(filePath, body);
  await chmod(filePath, 0o755);
  return filePath;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const pi: AvailableAgent = { id: "pi", label: "pi", binary: "/Users/me/.local/bin/pi", shellCommand: "/Users/me/.local/bin/pi" };

describe("agent allowlist", () => {
  it("offers only the five known agents, looked up by fixed name in the install dirs", () => {
    const definitions = buildAgentDefinitions("/Users/me", ["/Users/me/.local/bin", "/opt/homebrew/bin"]);
    expect(definitions.map((entry) => entry.id)).toEqual(["claude", "hax", "opencode", "pi", "codex"]);
    expect(definitions.find((entry) => entry.id === "hax")?.candidates).toEqual(["/Users/me/.local/bin/hax", "/opt/homebrew/bin/hax"]);
    expect(definitions.find((entry) => entry.id === "pi")?.candidates).toEqual(["/Users/me/.local/bin/pi", "/opt/homebrew/bin/pi"]);
    expect(definitions.filter((entry) => entry.byName).map((entry) => entry.id)).toEqual(["codex"]);
  });

  it("searches ~/.local/bin, Homebrew and /usr/local before the server PATH, once each", () => {
    expect(agentBinaryDirs("/Users/me", "/Users/me/.gp/tools/atw/bin:/opt/homebrew/bin:relative:/usr/bin")).toEqual([
      "/Users/me/.local/bin",
      "/opt/homebrew/bin",
      "/usr/local/bin",
      "/Users/me/.gp/tools/atw/bin",
      "/usr/bin"
    ]);
    expect(agentBinaryDirs("/Users/me", "")).toEqual(["/Users/me/.local/bin", "/opt/homebrew/bin", "/usr/local/bin"]);
  });

  it("launches the first install found, by path, except codex which runs by name", async () => {
    const home = await makeTempDir();
    const local = path.join(home, ".local/bin");
    const brew = path.join(home, "brew");
    await mkdir(local, { recursive: true });
    await mkdir(brew);
    // pi installs as a symlink in ~/.local/bin pointing at its managed launcher.
    const piLauncher = await makeExecutable(path.join(home, "pi-launcher"));
    await symlink(piLauncher, path.join(local, "pi"));
    await makeExecutable(path.join(brew, "pi"));
    await makeExecutable(path.join(brew, "codex"));
    await makeExecutable(path.join(brew, "claude"));
    await makeExecutable(path.join(brew, "hax"));
    // A directory with an agent's name is not an install.
    await mkdir(path.join(local, "claude"));

    const available = await listAvailableAgents(buildAgentDefinitions(home, [local, brew]));
    expect(available).toEqual([
      { id: "claude", label: "Claude Code", binary: path.join(brew, "claude"), shellCommand: path.join(brew, "claude") },
      { id: "hax", label: "hax", binary: path.join(brew, "hax"), shellCommand: path.join(brew, "hax") },
      { id: "pi", label: "pi", binary: path.join(local, "pi"), shellCommand: path.join(local, "pi") },
      { id: "codex", label: "Codex", binary: path.join(brew, "codex"), shellCommand: "codex" }
    ]);
  });

  it("quotes install paths that need it for the login shell", () => {
    expect(shellQuote("/Users/me/.local/bin/pi")).toBe("/Users/me/.local/bin/pi");
    expect(shellQuote("/Users/me/My Tools/it's/pi")).toBe("'/Users/me/My Tools/it'\\''s/pi'");
  });

  it("rejects agents that are not on the allowlist", () => {
    expect(findAgentDefinition("pi", [pi])).toBe(pi);
    for (const bad of ["bash", "pi; rm -rf ~", "", undefined, 42]) {
      expect(() => findAgentDefinition(bad, [pi])).toThrow(AgentRequestError);
    }
    try {
      findAgentDefinition("bash", [pi]);
    } catch (error) {
      expect((error as AgentRequestError).statusCode).toBe(400);
    }
  });

  it("hides agents whose binary is missing or not executable", async () => {
    const dir = await makeTempDir();
    const present = await makeExecutable(path.join(dir, "present"));
    const notExecutable = path.join(dir, "plain");
    await writeFile(notExecutable, "");
    const available = await listAvailableAgents([
      { id: "a", label: "A", command: "present", candidates: [path.join(dir, "missing"), present] },
      { id: "b", label: "B", command: "missing", candidates: [path.join(dir, "missing")] },
      { id: "c", label: "C", command: "plain", candidates: [notExecutable] }
    ]);
    expect(available).toEqual([{ id: "a", label: "A", binary: present, shellCommand: present }]);
  });
});

describe("agent directory validation", () => {
  it("accepts existing directories and expands ~", async () => {
    const home = await makeTempDir();
    await mkdir(path.join(home, "work", "repo"), { recursive: true });
    const resolvedHome = await resolveAgentDirectory(home, home);
    expect(await resolveAgentDirectory("~", home)).toBe(resolvedHome);
    expect(await resolveAgentDirectory("~/work/repo/", home)).toBe(path.join(resolvedHome, "work", "repo"));
    expect(await resolveAgentDirectory(`  ${home}/work  `, home)).toBe(path.join(resolvedHome, "work"));
  });

  it("rejects missing, relative, empty and non-directory paths", async () => {
    const home = await makeTempDir();
    await writeFile(path.join(home, "file.txt"), "x");
    await expect(resolveAgentDirectory(path.join(home, "nope"), home)).rejects.toThrow(/does not exist/);
    await expect(resolveAgentDirectory(path.join(home, "file.txt"), home)).rejects.toThrow(/Not a directory/);
    await expect(resolveAgentDirectory("work/repo", home)).rejects.toThrow(/absolute/);
    await expect(resolveAgentDirectory("~other/x", home)).rejects.toThrow(/absolute/);
    await expect(resolveAgentDirectory("   ", home)).rejects.toThrow(/Missing directory/);
    await expect(resolveAgentDirectory(undefined, home)).rejects.toBeInstanceOf(AgentRequestError);
  });
});

describe("agent tmux arguments", () => {
  it("opens a new window in main with the agent run by the login shell as argv", () => {
    expect(buildNewAgentTmuxArgs({ definition: pi, directory: "/Users/me/work/atw", shell: "/bin/zsh", sessionExists: true })).toEqual([
      "new-window", "-t", "=main:", "-P", "-F", "#{pane_id}",
      "-c", "/Users/me/work/atw", "-n", "pi:atw",
      "/bin/zsh", "-lic", "cd /Users/me/work/atw && /Users/me/.local/bin/pi; exec /bin/zsh -l"
    ]);
  });

  it("creates the main session when it does not exist yet", () => {
    expect(buildNewAgentTmuxArgs({ definition: pi, directory: "/srv/x", shell: "/bin/zsh", sessionExists: false }).slice(0, 7)).toEqual([
      "new-session", "-d", "-s", "main", "-P", "-F", "#{pane_id}"
    ]);
  });

  it("keeps directory text out of the shell command and sanitizes the window name", () => {
    const directory = "/tmp/$(touch pwned); echo `id` #x";
    const args = buildNewAgentTmuxArgs({ definition: pi, directory, shell: "/bin/zsh", sessionExists: true });
    expect(args[args.indexOf("-c") + 1]).toBe(directory);
    expect(args[args.indexOf("-n") + 1]).toBe("pi:touch-pwned-echo-id-x");
    expect(buildAgentShellArgv(pi, "/bin/zsh", directory)[2]).toBe(`cd '/tmp/$(touch pwned); echo \`id\` #x' && /Users/me/.local/bin/pi; exec /bin/zsh -l`);
    expect(args.slice(-3)).toEqual(buildAgentShellArgv(pi, "/bin/zsh", directory));
    expect(buildAgentWindowName("codex", "/")).toBe("codex:root");
  });

  it("quotes a directory with a space and a single quote so the shell cds into it verbatim", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "atw-cd-"));
    tempDirs.push(root);
    const directory = path.join(root, "it's a dir");
    await mkdir(directory);
    const script = buildAgentShellArgv(pi, "/bin/zsh", directory)[2];
    expect(script).toBe(`cd ${shellQuote(directory)} && /Users/me/.local/bin/pi; exec /bin/zsh -l`);
    expect(shellQuote(directory)).toContain("'\\''");
    const cd = script.slice(0, script.indexOf(" && "));
    const echoed = spawnSync("/bin/sh", ["-c", `${cd} && pwd -P`], { cwd: "/" });
    expect(echoed.stdout.toString().trim()).toBe(await realpath(directory));
  });
});

describe("named new agents", () => {
  const claude: AvailableAgent = { id: "claude", label: "Claude Code", binary: "/Users/me/.local/bin/claude", shellCommand: "/Users/me/.local/bin/claude" };
  const codex: AvailableAgent = { id: "codex", label: "Codex", binary: "/opt/homebrew/bin/codex", shellCommand: "codex" };

  it("passes the name to claude and pi as --name and uses it as the window name", () => {
    const args = buildNewAgentTmuxArgs({ definition: claude, directory: "/Users/me/work/atw", shell: "/bin/zsh", sessionExists: true, name: "fix auth" });
    expect(args.slice(args.indexOf("-n"))).toEqual([
      "-n", "fix auth",
      "/bin/zsh", "-lic", "cd /Users/me/work/atw && /Users/me/.local/bin/claude --name 'fix auth'; exec /bin/zsh -l"
    ]);
    expect(buildAgentShellArgv(pi, "/bin/zsh", "/srv/x", "x")[2]).toBe("cd /srv/x && /Users/me/.local/bin/pi --name x; exec /bin/zsh -l");
  });

  it("leaves the launch and window name unchanged for an empty name", () => {
    const plain = buildNewAgentTmuxArgs({ definition: claude, directory: "/srv/x", shell: "/bin/zsh", sessionExists: true });
    expect(buildNewAgentTmuxArgs({ definition: claude, directory: "/srv/x", shell: "/bin/zsh", sessionExists: true, name: "" })).toEqual(plain);
    expect(plain.slice(plain.indexOf("-n"))).toEqual(["-n", "claude:x", "/bin/zsh", "-lic", "cd /srv/x && /Users/me/.local/bin/claude; exec /bin/zsh -l"]);
  });

  it("single-quotes a hostile name so the shell sees one argument", () => {
    const name = sanitizeNewAgentName("a'; rm -rf ~ #");
    const args = buildNewAgentTmuxArgs({ definition: claude, directory: "/srv/x", shell: "/bin/zsh", sessionExists: true, name });
    const command = args[args.length - 1];
    expect(command).toBe(`cd /srv/x && /Users/me/.local/bin/claude --name 'a'\\''; rm -rf ~ #'; exec /bin/zsh -l`);
    // The window name drops everything tmux or a shell could act on.
    expect(args[args.indexOf("-n") + 1]).not.toMatch(/[';~#]/);
    const echoed = spawnSync("/bin/sh", ["-c", `printf '%s' ${command.slice(command.indexOf("--name ") + 7, command.indexOf("; exec"))}`]);
    expect(echoed.stdout.toString()).toBe("a'; rm -rf ~ #");
  });

  it("sanitizes the window name against tmux format expansion", () => {
    expect(buildAgentWindowName("claude", "/srv/x", "#(touch pwned) #{pane_id}")).toBe("touch pwned- -pane_id");
    expect(buildAgentWindowName("claude", "/srv/x", "###")).toBe("claude:x");
    expect(buildAgentWindowName("claude", "/srv/x", "a".repeat(100))).toBe("a".repeat(40));
  });

  it("flattens control characters and drops leading dashes", () => {
    expect(sanitizeNewAgentName("  --evil\nname\u0007 ")).toBe("evil name");
    expect(sanitizeNewAgentName("---")).toBe("");
    expect(sanitizeNewAgentName(undefined)).toBe("");
    expect(sanitizeNewAgentName("x".repeat(150))).toHaveLength(100);
    const args = buildAgentShellArgv(claude, "/bin/zsh", "/srv/x", "--evil");
    expect(args[2]).toBe("cd /srv/x && /Users/me/.local/bin/claude --name evil; exec /bin/zsh -l");
  });

  it("renames after launch only for agents with a rename command but no launch flag", () => {
    expect(buildAgentShellArgv(codex, "/bin/zsh", "/srv/x", "x")[2]).toBe("cd /srv/x && codex; exec /bin/zsh -l");
    expect(agentRenamesAfterLaunch("codex", "x")).toBe(true);
    expect(agentRenamesAfterLaunch("codex", "")).toBe(false);
    for (const id of ["claude", "pi", "hax", "opencode"]) {
      expect(agentRenamesAfterLaunch(id, "x")).toBe(false);
    }
  });
});

describe("agent directory suggestions", () => {
  it("lists git repos under the roots and merges pane cwds, most recent first", async () => {
    const home = await makeTempDir();
    const work = path.join(home, "work");
    const gp = path.join(home, ".gp");
    for (const repo of [path.join(work, "old"), path.join(work, "new"), gp]) {
      await mkdir(path.join(repo, ".git"), { recursive: true });
    }
    await mkdir(path.join(work, "not-a-repo"), { recursive: true });
    const stamp = (seconds: number) => new Date(seconds * 1000);
    await utimes(path.join(work, "old", ".git"), stamp(1_000), stamp(1_000));
    await utimes(path.join(work, "new", ".git"), stamp(3_000), stamp(3_000));
    await utimes(path.join(gp, ".git"), stamp(2_000), stamp(2_000));

    const repos = await findGitRepos([work, gp, path.join(home, "missing")]);
    expect(repos.map((repo) => repo.path).sort()).toEqual([gp, path.join(work, "new"), path.join(work, "old")].sort());

    const directories = await listAgentDirectories([
      { currentPath: path.join(home, "scratch"), activityAtMs: 2_500_000 },
      { currentPath: path.join(work, "old"), activityAtMs: 4_000_000 },
      {}
    ], home, [work, gp]);
    expect(directories).toEqual([
      { path: path.join(work, "old"), label: "~/work/old", source: "pane" },
      { path: path.join(work, "new"), label: "~/work/new", source: "repo" },
      { path: path.join(home, "scratch"), label: "~/scratch", source: "pane" },
      { path: gp, label: "~/.gp", source: "repo" }
    ]);
  });

  it("dedupes and caps the list", () => {
    const merged = mergeAgentDirectories([
      { path: "/h/a", source: "repo", timestampMs: 5 },
      { path: "/h/a", source: "pane", timestampMs: 1 },
      { path: "/h/b", source: "repo", timestampMs: 3 },
      { path: "/h/c", source: "repo", timestampMs: 1 }
    ], "/h", 2);
    expect(merged).toEqual([
      { path: "/h/a", label: "~/a", source: "pane" },
      { path: "/h/b", label: "~/b", source: "repo" }
    ]);
  });
});

const tmuxAvailable = spawnSync("tmux", ["-V"]).status === 0;

describe.skipIf(!tmuxAvailable)("starting an agent against a real tmux server", () => {
  const savedTmuxTmpdir = process.env.TMUX_TMPDIR;
  const savedTmux = process.env.TMUX;
  let socketDir = "";
  let socketPath = "";
  let workDir = "";
  // Every direct tmux call names the private socket, so a leaked TMUX can never aim one at the live server.
  const testTmux = (args: string[]) => execFileAsync("tmux", ["-S", socketPath, ...args]);

  beforeAll(async () => {
    // Private socket dir so the code under test never touches the developer's tmux server.
    socketDir = await realpath(await mkdtemp(path.join(tmpdir(), "atw-agent-tmux-")));
    socketPath = path.join(socketDir, `tmux-${process.getuid?.() ?? 0}`, "default");
    workDir = await mkdtemp(path.join(tmpdir(), "atw-agent-work-"));
    await mkdir(path.dirname(socketPath), { recursive: true, mode: 0o700 });
    process.env.TMUX_TMPDIR = socketDir;
    delete process.env.TMUX;
  });

  afterAll(async () => {
    if (socketPath) await testTmux(["kill-server"]).catch(() => undefined);
    if (savedTmuxTmpdir === undefined) {
      delete process.env.TMUX_TMPDIR;
    } else {
      process.env.TMUX_TMPDIR = savedTmuxTmpdir;
    }
    if (savedTmux !== undefined) {
      process.env.TMUX = savedTmux;
    }
    await rm(socketDir, { recursive: true, force: true });
    await rm(workDir, { recursive: true, force: true });
  });

  it("creates main, then adds windows to it, each running the allowlisted command", async () => {
    const binary = await makeExecutable(path.join(workDir, "fake-agent"));
    // Stands in for the login shell: records its argv instead of loading rc files.
    const shell = await makeExecutable(
      path.join(workDir, "fake-shell"),
      `#!/bin/sh\nprintf '%s\\n' "$PWD" "$@" > "$PWD/.agent-args"\nexec sleep 30\n`
    );
    const project = path.join(workDir, "my project");
    await mkdir(project);
    const definitions = [{ id: "pi", label: "pi", command: "fake-agent", candidates: [binary] }];

    const first = await startAgentInTmux("pi", project, { definitions, shell });
    const second = await startAgentInTmux("pi", workDir, { definitions, shell });
    expect(first.pane).toMatch(/^%\d+$/);
    expect(second.pane).not.toBe(first.pane);

    const { stdout: socket } = await execFileAsync("tmux", ["display-message", "-p", "-t", first.pane, "#{socket_path}"]);
    expect(socket.trim()).toBe(socketPath);
    const { stdout } = await testTmux(["list-panes", "-t", "=main", "-s", "-F", "#{pane_id}\t#{window_name}"]);
    expect(stdout.trim().split("\n")).toEqual([`${first.pane}\tpi:my-project`, `${second.pane}\tpi:${path.basename(workDir)}`]);

    let recorded = "";
    for (let attempt = 0; attempt < 30 && !recorded; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      recorded = await readFile(path.join(project, ".agent-args"), "utf8").catch(() => "");
    }
    expect(recorded.trim().split("\n")).toEqual([first.directory, "-lic", `cd ${shellQuote(first.directory)} && ${binary}; exec ${shell} -l`]);

    await expect(startAgentInTmux("bash", project, { definitions, shell })).rejects.toThrow(/Unknown agent/);
    await expect(startAgentInTmux("pi", path.join(workDir, "missing"), { definitions, shell })).rejects.toThrow(/does not exist/);
  });

  it("names the window and passes the quoted name to a launch-flag agent", async () => {
    const binary = await makeExecutable(path.join(workDir, "fake-pi"));
    const shell = await makeExecutable(
      path.join(workDir, "named-shell"),
      `#!/bin/sh\nprintf '%s\\n' "$@" > "$PWD/.named-args"\nexec sleep 30\n`
    );
    const project = path.join(workDir, "named project");
    await mkdir(project);
    const definitions = [{ id: "pi", label: "pi", command: "fake-pi", candidates: [binary] }];

    const started = await startAgentInTmux("pi", project, { definitions, shell, name: "a'; rm -rf ~ #" });
    expect(started.windowName).toBe("a- rm -rf");
    const { stdout } = await testTmux(["display-message", "-p", "-t", started.pane, "#{window_name}"]);
    expect(stdout.trim()).toBe("a- rm -rf");

    let recorded = "";
    for (let attempt = 0; attempt < 30 && !recorded; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      recorded = await readFile(path.join(project, ".named-args"), "utf8").catch(() => "");
    }
    expect(recorded.trim().split("\n")).toEqual(["-lic", `cd ${shellQuote(started.directory)} && ${binary} --name 'a'\\''; rm -rf ~ #'; exec ${shell} -l`]);
  });
});
