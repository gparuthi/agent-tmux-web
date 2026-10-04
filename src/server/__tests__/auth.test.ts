import http from "node:http";
import type { AddressInfo } from "node:net";

import express from "express";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";

import {
  AUTH_COOKIE_MAX_AGE_SECONDS,
  AUTH_COOKIE_NAME,
  buildAuthCookie,
  createAuthMiddleware,
  isAuthorizedWebSocketRequest,
  isValidAuthToken,
  parseCookieHeader
} from "../auth.js";

const TOKEN = "s3cret-token_value";

describe("auth helpers", () => {
  it("compares tokens exactly", () => {
    expect(isValidAuthToken(TOKEN, TOKEN)).toBe(true);
    expect(isValidAuthToken(TOKEN, `${TOKEN}x`)).toBe(false);
    expect(isValidAuthToken(TOKEN, "")).toBe(false);
    expect(isValidAuthToken("", "")).toBe(false);
  });

  it("parses cookie headers, keeping the first value of a name", () => {
    const cookies = parseCookieHeader(`a=1; ${AUTH_COOKIE_NAME}=x%20y; ${AUTH_COOKIE_NAME}=later; junk; =bad`);
    expect(cookies.get("a")).toBe("1");
    expect(cookies.get(AUTH_COOKIE_NAME)).toBe("x y");
    expect(parseCookieHeader(undefined).size).toBe(0);
    expect(parseCookieHeader(`${AUTH_COOKIE_NAME}=%E0%A4%A`).get(AUTH_COOKIE_NAME)).toBe("%E0%A4%A");
  });

  it("builds a strict, http-only, long-lived cookie", () => {
    const cookie = buildAuthCookie(TOKEN);
    expect(cookie).toBe(`${AUTH_COOKIE_NAME}=${TOKEN}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${AUTH_COOKIE_MAX_AGE_SECONDS}`);
    expect(AUTH_COOKIE_MAX_AGE_SECONDS).toBe(400 * 24 * 60 * 60);
  });
});

describe("auth middleware and websocket check", () => {
  let server: http.Server;
  let baseUrl = "";
  let wsBaseUrl = "";

  beforeEach(async () => {
    const app = express();
    app.use(createAuthMiddleware({
      authToken: TOKEN,
      isPublicRequest: (req) => req.path === "/healthz"
    }));
    app.get("/healthz", (_req, res) => {
      res.json({ ok: true });
    });
    app.get("/api/tmux/sessions", (_req, res) => {
      res.json({ sessions: [] });
    });
    app.get("/", (_req, res) => {
      res.type("html").send("<!doctype html><title>app</title>");
    });

    server = http.createServer(app);
    const wss = new WebSocketServer({ noServer: true });
    server.on("upgrade", (req, socket, head) => {
      wss.handleUpgrade(req, socket, head, (webSocket) => {
        if (!isAuthorizedWebSocketRequest(TOKEN, req)) {
          webSocket.close(1008, "Unauthorized");
          return;
        }
        webSocket.send("hello");
      });
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
    wsBaseUrl = `ws://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  // Node fetch forces Sec-Fetch-Mode: cors, so navigations go through http.get.
  function rawGet(path: string, headers: Record<string, string>): Promise<{ status: number; contentType: string; body: string }> {
    return new Promise((resolve, reject) => {
      http.get(`${baseUrl}${path}`, { headers }, (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => { body += chunk; });
        response.on("end", () => resolve({
          status: response.statusCode ?? 0,
          contentType: String(response.headers["content-type"] ?? ""),
          body
        }));
      }).on("error", reject);
    });
  }

  function cookieHeader(token: string): Record<string, string> {
    return { cookie: `other=1; ${AUTH_COOKIE_NAME}=${encodeURIComponent(token)}` };
  }

  it("sets the cookie when a valid query token arrives", async () => {
    const response = await fetch(`${baseUrl}/?token=${TOKEN}`);
    expect(response.status).toBe(200);
    expect(response.headers.getSetCookie()).toEqual([buildAuthCookie(TOKEN)]);
  });

  it("sets the cookie when a valid header token arrives", async () => {
    const response = await fetch(`${baseUrl}/api/tmux/sessions`, {
      headers: { "x-agent-tmux-web-token": TOKEN }
    });
    expect(response.status).toBe(200);
    expect(response.headers.getSetCookie()).toEqual([buildAuthCookie(TOKEN)]);
  });

  it("does not re-set a cookie the request already carries", async () => {
    const response = await fetch(`${baseUrl}/api/tmux/sessions?token=${TOKEN}`, { headers: cookieHeader(TOKEN) });
    expect(response.status).toBe(200);
    expect(response.headers.getSetCookie()).toEqual([]);
  });

  it("sets no cookie for an invalid token", async () => {
    const response = await fetch(`${baseUrl}/api/tmux/sessions?token=wrong`);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Unauthorized" });
    expect(response.headers.getSetCookie()).toEqual([]);
  });

  it("accepts the cookie alone for API calls", async () => {
    const response = await fetch(`${baseUrl}/api/tmux/sessions`, { headers: cookieHeader(TOKEN) });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ sessions: [] });
    expect(response.headers.getSetCookie()).toEqual([]);
  });

  it("rejects an invalid cookie", async () => {
    const response = await fetch(`${baseUrl}/api/tmux/sessions`, { headers: cookieHeader("wrong") });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Unauthorized" });
  });

  it("keeps public routes open", async () => {
    const response = await fetch(`${baseUrl}/healthz`);
    expect(response.status).toBe(200);
  });

  it("serves an HTML sign-in page to unauthenticated navigations", async () => {
    const response = await rawGet("/?tmuxSession=demo&token=wrong", {
      accept: "text/html,application/xhtml+xml",
      "sec-fetch-mode": "navigate"
    });
    expect(response.status).toBe(401);
    expect(response.contentType).toContain("text/html");
    const html = response.body;
    expect(html).toContain("?token=");
    expect(html).toContain('href="/?tmuxSession=demo"');
    expect(html).not.toContain("wrong");
    expect(html).not.toContain("<script");
  });

  it("detects navigations from Accept when Sec-Fetch-Mode is absent", async () => {
    const response = await rawGet("/", { accept: "text/html" });
    expect(response.status).toBe(401);
    expect(response.contentType).toContain("text/html");
  });

  it("keeps JSON 401s for API routes and non-navigation fetches", async () => {
    const api = await rawGet("/api/tmux/sessions", { accept: "text/html", "sec-fetch-mode": "navigate" });
    expect(api.status).toBe(401);
    expect(JSON.parse(api.body)).toEqual({ error: "Unauthorized" });

    const fetchMode = await rawGet("/", { accept: "text/html", "sec-fetch-mode": "cors" });
    expect(fetchMode.status).toBe(401);
    expect(JSON.parse(fetchMode.body)).toEqual({ error: "Unauthorized" });
  });

  function openSocket(path: string, headers: Record<string, string> = {}): Promise<{ message?: string; closeCode?: number }> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(`${wsBaseUrl}${path}`, { headers });
      socket.once("message", (data) => {
        socket.close();
        resolve({ message: String(data) });
      });
      socket.once("close", (code) => resolve({ closeCode: code }));
      socket.once("error", reject);
    });
  }

  it("authorizes websockets by cookie or query token", async () => {
    await expect(openSocket("/ws", cookieHeader(TOKEN))).resolves.toEqual({ message: "hello" });
    await expect(openSocket(`/tmux-ws?session=a&token=${TOKEN}`)).resolves.toEqual({ message: "hello" });
  });

  it("rejects websockets with an invalid or missing cookie", async () => {
    await expect(openSocket("/ws", cookieHeader("wrong"))).resolves.toEqual({ closeCode: 1008 });
    await expect(openSocket("/ws")).resolves.toEqual({ closeCode: 1008 });
  });

  it("allows every websocket when auth is disabled", () => {
    const req = { url: "/ws", headers: {} } as http.IncomingMessage;
    expect(isAuthorizedWebSocketRequest("", req)).toBe(true);
    expect(isAuthorizedWebSocketRequest(TOKEN, req)).toBe(false);
  });
});
