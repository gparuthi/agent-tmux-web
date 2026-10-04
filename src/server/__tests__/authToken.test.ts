import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { resolveAuthToken } from "../authToken.js";

describe("resolveAuthToken", () => {
  let dir = "";

  afterEach(async () => {
    if (dir) {
      await rm(dir, { recursive: true, force: true });
      dir = "";
    }
  });

  async function tokenFile(contents: string): Promise<string> {
    dir = await mkdtemp(path.join(os.tmpdir(), "atw-token-"));
    const filePath = path.join(dir, "token");
    await writeFile(filePath, contents, { mode: 0o600 });
    return filePath;
  }

  it("returns no token when nothing is configured", () => {
    expect(resolveAuthToken({})).toBe("");
  });

  it("reads the token from the env var and the legacy alias", () => {
    expect(resolveAuthToken({ AGENT_TMUX_WEB_AUTH_TOKEN: "env-token" })).toBe("env-token");
    expect(resolveAuthToken({ CODEX_WEB_AUTH_TOKEN: "legacy-token" })).toBe("legacy-token");
  });

  it("reads and trims the token file", async () => {
    const filePath = await tokenFile("file-token\n");
    expect(resolveAuthToken({ AGENT_TMUX_WEB_AUTH_TOKEN_FILE: filePath })).toBe("file-token");
  });

  it("prefers an explicit env token over the file", async () => {
    const filePath = await tokenFile("file-token");
    expect(resolveAuthToken({ AGENT_TMUX_WEB_AUTH_TOKEN: "env-token", AGENT_TMUX_WEB_AUTH_TOKEN_FILE: filePath })).toBe("env-token");
  });

  it("refuses to start without auth when the token file is empty or missing", async () => {
    const filePath = await tokenFile(" \n");
    expect(() => resolveAuthToken({ AGENT_TMUX_WEB_AUTH_TOKEN_FILE: filePath })).toThrow(/is empty/);
    expect(() => resolveAuthToken({ AGENT_TMUX_WEB_AUTH_TOKEN_FILE: path.join(dir, "missing") })).toThrow(/ENOENT/);
  });
});
