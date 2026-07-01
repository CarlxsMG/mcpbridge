const CSRF_COOKIE_NAME = "__Host-mcp_admin_csrf";

/** Reads the CSRF token straight from its (non-httpOnly, by design) cookie. */
export function readCsrfCookie(): string | null {
  const prefix = `${CSRF_COOKIE_NAME}=`;
  const match = document.cookie.split("; ").find((c) => c.startsWith(prefix));
  if (!match) return null;
  return decodeURIComponent(match.slice(prefix.length));
}
