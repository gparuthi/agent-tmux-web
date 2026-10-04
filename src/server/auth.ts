import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

import type { NextFunction, Request, Response } from "express";

export const AUTH_COOKIE_NAME = "atw_token";
// Browsers cap cookie lifetime at 400 days.
export const AUTH_COOKIE_MAX_AGE_SECONDS = 400 * 24 * 60 * 60;

export type AuthSource = "header" | "query" | "cookie";

export type AuthResult = {
  ok: boolean;
  source: AuthSource | null;
  // True when the request already carries a valid auth cookie.
  cookieValid: boolean;
};

export function isValidAuthToken(expected: string, provided: string): boolean {
  if (!expected || !provided) {
    return false;
  }

  const expectedBytes = Buffer.from(expected);
  const actualBytes = Buffer.from(provided);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

export function parseCookieHeader(header: string | string[] | undefined): Map<string, string> {
  const cookies = new Map<string, string>();
  const raw = Array.isArray(header) ? header.join("; ") : header ?? "";
  for (const part of raw.split(";")) {
    const separator = part.indexOf("=");
    if (separator <= 0) {
      continue;
    }
    const name = part.slice(0, separator).trim();
    if (!name || cookies.has(name)) {
      continue;
    }
    cookies.set(name, safeDecode(part.slice(separator + 1).trim()));
  }
  return cookies;
}

export function readAuthCookie(header: string | string[] | undefined): string {
  return parseCookieHeader(header).get(AUTH_COOKIE_NAME) ?? "";
}

export function buildAuthCookie(token: string): string {
  return [
    `${AUTH_COOKIE_NAME}=${encodeURIComponent(token)}`,
    "HttpOnly",
    "Secure",
    "SameSite=Strict",
    "Path=/",
    `Max-Age=${AUTH_COOKIE_MAX_AGE_SECONDS}`
  ].join("; ");
}

export function authenticate(expected: string, credentials: {
  header?: string;
  query?: string;
  cookieHeader?: string | string[];
}): AuthResult {
  const cookieValid = isValidAuthToken(expected, readAuthCookie(credentials.cookieHeader));
  if (isValidAuthToken(expected, credentials.header ?? "")) {
    return { ok: true, source: "header", cookieValid };
  }
  if (isValidAuthToken(expected, credentials.query ?? "")) {
    return { ok: true, source: "query", cookieValid };
  }
  return { ok: cookieValid, source: cookieValid ? "cookie" : null, cookieValid };
}

// ATW_TAILSCALE_LOGINS: comma-separated tailnet logins; empty turns identity auth off.
export function parseTailscaleLogins(value: string | undefined): ReadonlySet<string> {
  return new Set((value ?? "").split(",").map((login) => login.trim().toLowerCase()).filter(Boolean));
}

export function isLoopbackAddress(address: string | undefined): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

// tailscale serve proxies from loopback and sets Tailscale-User-Login for tailnet users only, stripping client copies.
export function isTailscaleIdentityRequest(logins: ReadonlySet<string>, req: IncomingMessage): boolean {
  if (logins.size === 0 || !isLoopbackAddress(req.socket?.remoteAddress)) {
    return false;
  }
  const login = req.headers["tailscale-user-login"];
  return typeof login === "string" && logins.has(login.trim().toLowerCase());
}

export function createAuthMiddleware(options: {
  authToken: string;
  isPublicRequest: (req: Request) => boolean;
  tailscaleLogins?: ReadonlySet<string>;
}) {
  const tailscaleLogins = options.tailscaleLogins ?? new Set<string>();
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!options.authToken || options.isPublicRequest(req)) {
      next();
      return;
    }

    // No token involved, so no token cookie either.
    if (isTailscaleIdentityRequest(tailscaleLogins, req)) {
      next();
      return;
    }

    const result = authenticate(options.authToken, {
      header: req.header("x-agent-tmux-web-token") ?? req.header("x-codex-web-token") ?? "",
      query: typeof req.query.token === "string" ? req.query.token : "",
      cookieHeader: req.headers.cookie
    });
    if (result.ok) {
      if (result.source !== "cookie" && !result.cookieValid) {
        res.append("Set-Cookie", buildAuthCookie(options.authToken));
      }
      next();
      return;
    }

    if (isHtmlNavigation(req)) {
      res.status(401).type("html").send(renderSignInPage(req.originalUrl));
      return;
    }
    res.status(401).json({ error: "Unauthorized" });
  };
}

export function isAuthorizedWebSocketRequest(
  authToken: string,
  req: IncomingMessage,
  tailscaleLogins: ReadonlySet<string> = new Set()
): boolean {
  if (!authToken || isTailscaleIdentityRequest(tailscaleLogins, req)) {
    return true;
  }
  const url = new URL(req.url ?? "/", "http://localhost");
  return authenticate(authToken, {
    query: url.searchParams.get("token") ?? "",
    cookieHeader: req.headers.cookie
  }).ok;
}

export function isHtmlNavigation(req: Request): boolean {
  if (req.method !== "GET" || req.path.toLowerCase().startsWith("/api/")) {
    return false;
  }
  const mode = req.header("sec-fetch-mode");
  if (mode) {
    return mode === "navigate";
  }
  return (req.header("accept") ?? "").includes("text/html");
}

function renderSignInPage(originalUrl: string): string {
  const retryHref = escapeHtml(buildRetryHref(originalUrl));
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Agent Tmux: sign in</title>
<style>
body { font: 16px/1.5 -apple-system, system-ui, sans-serif; margin: 0; padding: 2rem 1.25rem; background: #111; color: #eee; }
main { max-width: 32rem; margin: 0 auto; }
code { background: #222; padding: 0.1rem 0.3rem; border-radius: 4px; }
a { color: #8ab4f8; }
</style>
</head>
<body>
<main>
<h1>Not signed in on this device</h1>
<p>Open Agent Tmux once with <code>?token=…</code> in the URL to sign in. The token is then remembered in a cookie and removed from the address bar.</p>
<p>Already signed in? Links from other sites do not carry the sign-in cookie. <a href="${retryHref}">Open Agent Tmux</a></p>
</main>
</body>
</html>
`;
}

// Same-origin path and query, minus any stale token.
function buildRetryHref(originalUrl: string): string {
  const url = new URL(originalUrl, "http://localhost");
  url.searchParams.delete("token");
  return `${url.pathname}${url.search}`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
