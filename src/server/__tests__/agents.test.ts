import { execFile, spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
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
  startAgentInTmux,
  type AgentDefinition
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

const pi: AgentDefinition = { id: "pi", label: "pi", binary: "/opt/homebrew/bin/pi", shellCommand: "/opt/homebrew/bin/pi" };

describe("agent allowlist", () => {
  it("offers only the four known agents, with fixed commands", () => {
    const definitions = buildAgentDefinitions("/Users/me");
    expect(definitions.map((entry) => entry.id)).toEqual(["opencode", "pi", "claude", "codex"]);
    expect(definitions.find((entry) => entry.id === "claude")?.shellCommand).toBe("/Users/me/.local/bin/claude");
    expect(definitions.find((entry) => entry.id === "codex")?.shellCommand).toBe("codex");
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
      { id: "a", label: "A", binary: present, shellCommand: present },
      { id: "b", label: "B", binary: path.join(dir, "missing"), shellCommand: "missing" },
      { id: "c", label: "C", binary: notExecutable, shellCommand: notExecutable }
    ]);
    expect(available.map((entry) => entry.id)).toEqual(["a"]);
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
      "/bin/zsh", "-lic", "/opt/homebrew/bin/pi; exec /bin/zsh -l"
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
    expect(buildAgentShellArgv(pi, "/bin/zsh").join(" ")).not.toContain("touch");
    expect(args.slice(-3)).toEqual(buildAgentShellArgv(pi, "/bin/zsh"));
    expect(buildAgentWindowName("codex", "/")).toBe("codex:root");
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
  let workDir = "";

  beforeAll(async () => {
    // Private socket dir so the test never touches the developer's tmux server.
    socketDir = await mkdtemp(path.join(tmpdir(), "atw-agent-tmux-"));
    workDir = await mkdtemp(path.join(tmpdir(), "atw-agent-work-"));
    process.env.TMUX_TMPDIR = socketDir;
    delete process.env.TMUX;
  });

  afterAll(async () => {
    await execFileAsync("tmux", ["kill-server"]).catch(() => undefined);
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
    const definitions: AgentDefinition[] = [{ id: "pi", label: "pi", binary, shellCommand: binary }];

    const first = await startAgentInTmux("pi", project, { definitions, shell });
    const second = await startAgentInTmux("pi", workDir, { definitions, shell });
    expect(first.pane).toMatch(/^%\d+$/);
    expect(second.pane).not.toBe(first.pane);

    const { stdout } = await execFileAsync("tmux", ["list-panes", "-t", "=main", "-s", "-F", "#{pane_id}\t#{window_name}"]);
    expect(stdout.trim().split("\n")).toEqual([`${first.pane}\tpi:my-project`, `${second.pane}\tpi:${path.basename(workDir)}`]);

    let recorded = "";
    for (let attempt = 0; attempt < 30 && !recorded; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      recorded = await readFile(path.join(project, ".agent-args"), "utf8").catch(() => "");
    }
    expect(recorded.trim().split("\n")).toEqual([first.directory, "-lic", `${binary}; exec ${shell} -l`]);

    await expect(startAgentInTmux("bash", project, { definitions, shell })).rejects.toThrow(/Unknown agent/);
    await expect(startAgentInTmux("pi", path.join(workDir, "missing"), { definitions, shell })).rejects.toThrow(/does not exist/);
  });
});
