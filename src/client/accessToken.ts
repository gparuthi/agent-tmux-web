export const ACCESS_TOKEN_QUERY_PARAM = "token";

export function readAccessToken(search: string): string {
  return new URLSearchParams(search).get(ACCESS_TOKEN_QUERY_PARAM)?.trim() ?? "";
}

export function removeAccessToken(url: URL): string {
  url.searchParams.delete(ACCESS_TOKEN_QUERY_PARAM);
  return url.toString();
}

// Drop the URL token only once a token-less request proves the auth cookie works.
export async function dropAccessTokenFromAddressBar(options: {
  token: string;
  isAndroidApp: boolean;
  checkCookieSession: () => Promise<boolean>;
  currentHref: () => string;
  replaceHref: (href: string) => void;
}): Promise<boolean> {
  // The Android app reloads from its own launch URL and has no address bar to clean.
  if (!options.token || options.isAndroidApp) {
    return false;
  }
  if (!(await options.checkCookieSession().catch(() => false))) {
    return false;
  }
  const current = options.currentHref();
  const next = removeAccessToken(new URL(current));
  if (next === current) {
    return false;
  }
  options.replaceHref(next);
  return true;
}
