export const SESSION_COOKIE_NAME = "__Host-mcp_admin_session";
export const CSRF_COOKIE_NAME = "__Host-mcp_admin_csrf";

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
