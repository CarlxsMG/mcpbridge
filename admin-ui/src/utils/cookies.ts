// The backend only ever sets ONE of these, depending on its own
// SESSION_COOKIE_SECURE config (the __Host- prefix requires Secure, so it's
// dropped in insecure/plain-HTTP deployments) — this is a separate project
// with no access to that backend config, so it checks both rather than
// guessing. See src/security/cookies.ts on the backend for the source of truth.
const CSRF_COOKIE_NAMES = ["__Host-mcp_admin_csrf", "mcp_admin_csrf"];

/** Reads the CSRF token straight from its (non-httpOnly, by design) cookie. */
export function readCsrfCookie(): string | null {
  for (const name of CSRF_COOKIE_NAMES) {
    const prefix = `${name}=`;
    const match = document.cookie.split("; ").find((c) => c.startsWith(prefix));
    if (match) return decodeURIComponent(match.slice(prefix.length));
  }
  return null;
}
