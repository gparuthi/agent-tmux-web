import { describe, expect, it, vi } from "vitest";

import { dropAccessTokenFromAddressBar, readAccessToken, removeAccessToken } from "../accessToken.js";

describe("access token in the URL", () => {
  it("reads and trims the token query param", () => {
    expect(readAccessToken("?token=%20abc%20&tmuxSession=demo")).toBe("abc");
    expect(readAccessToken("?tmuxSession=demo")).toBe("");
  });

  it("removes only the token param", () => {
    expect(removeAccessToken(new URL("https://example.test/?token=abc&tmuxSession=demo#x")))
      .toBe("https://example.test/?tmuxSession=demo#x");
  });

  function options(overrides: Partial<Parameters<typeof dropAccessTokenFromAddressBar>[0]> = {}) {
    return {
      token: "abc",
      isAndroidApp: false,
      checkCookieSession: vi.fn(async () => true),
      currentHref: () => "https://example.test/?token=abc",
      replaceHref: vi.fn(),
      ...overrides
    };
  }

  it("drops the token once the cookie session is confirmed", async () => {
    const input = options();
    await expect(dropAccessTokenFromAddressBar(input)).resolves.toBe(true);
    expect(input.replaceHref).toHaveBeenCalledWith("https://example.test/");
  });

  it("keeps the token when the cookie session does not work", async () => {
    const rejected = options({ checkCookieSession: vi.fn(async () => false) });
    await expect(dropAccessTokenFromAddressBar(rejected)).resolves.toBe(false);
    expect(rejected.replaceHref).not.toHaveBeenCalled();

    const failed = options({ checkCookieSession: vi.fn(async () => { throw new Error("offline"); }) });
    await expect(dropAccessTokenFromAddressBar(failed)).resolves.toBe(false);
    expect(failed.replaceHref).not.toHaveBeenCalled();
  });

  it("leaves the Android app and token-less URLs alone", async () => {
    const android = options({ isAndroidApp: true });
    await expect(dropAccessTokenFromAddressBar(android)).resolves.toBe(false);
    expect(android.checkCookieSession).not.toHaveBeenCalled();

    const noToken = options({ token: "" });
    await expect(dropAccessTokenFromAddressBar(noToken)).resolves.toBe(false);
    expect(noToken.checkCookieSession).not.toHaveBeenCalled();
  });
});
