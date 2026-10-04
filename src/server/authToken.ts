import { readFileSync } from "node:fs";

type ReadTextFile = (filePath: string) => string;

// A token file keeps the secret out of the process environment, which any same-uid process can read.
export function resolveAuthToken(
  env: NodeJS.ProcessEnv,
  readTextFile: ReadTextFile = (filePath) => readFileSync(filePath, "utf8")
): string {
  const explicit = env.AGENT_TMUX_WEB_AUTH_TOKEN ?? env.CODEX_WEB_AUTH_TOKEN ?? "";
  if (explicit) {
    return explicit;
  }
  const tokenFile = env.AGENT_TMUX_WEB_AUTH_TOKEN_FILE ?? "";
  if (!tokenFile) {
    return "";
  }
  const token = readTextFile(tokenFile).trim();
  if (!token) {
    throw new Error(`AGENT_TMUX_WEB_AUTH_TOKEN_FILE is empty: ${tokenFile}`);
  }
  return token;
}
