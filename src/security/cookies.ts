import { config } from "../config.js";

/**
 * The `__Host-` prefix is a hard client-side requirement enforced by every
 * spec-compliant HTTP client (browsers, curl): it mandates the `Secure`
 * attribute (plus `Path=/` and no `Domain`). A cookie named with this prefix
 * but missing `Secure` is a self-contradiction — clients silently refuse to
 * store it, with no error surfaced anywhere. So the name itself must track
 * whether the cookie will actually carry `Secure`, not just that attribute
 * alone — otherwise SESSION_COOKIE_SECURE=false (the documented escape hatch
 * in security/startup-guards.ts for local plain-HTTP development) produces a
 * cookie no client can ever actually keep, and login silently doesn't stick.
 */
export function sessionCookieName(secure: boolean): string {
  return secure ? "__Host-mcp_admin_session" : "mcp_admin_session";
}

export function csrfCookieName(secure: boolean): string {
  return secure ? "__Host-mcp_admin_csrf" : "mcp_admin_csrf";
}

export const SESSION_COOKIE_NAME = sessionCookieName(config.sessionCookieSecure);
export const CSRF_COOKIE_NAME = csrfCookieName(config.sessionCookieSecure);

/**
 * Minimal Cookie-header parser — only handles the flat `name=value; name=value`
 * form browsers actually send on requests. Deliberately not a full RFC 6265
 * implementation: we only ever need to read our own two cookies by exact name.
 */
export function parseCookies(header: string | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  if (!header) return result;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const name = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (!name) continue;
    try {
      result[name] = decodeURIComponent(value);
    } catch {
      result[name] = value;
    }
  }
  return result;
}
