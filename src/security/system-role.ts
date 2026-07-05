import { config } from "../config.js";
import { safeCompare } from "./compare.js";
import { resolveMcpKeyByToken, touchMcpKeyLastUsed } from "./mcp-key-store.js";
import type { AdminRole } from "./user-store.js";

export interface SystemAuthResult {
  role: AdminRole;
  /** Whether this credential may skip the sensitive-tool confirm step (mirrors mcp_api_keys.elevated). */
  elevated: boolean;
  /** Managed key id, or null for the env admin Bearer (which isn't a DB row). */
  keyId: number | null;
  isEnvBearer: boolean;
}

/**
 * Resolves the caller's control-plane role for the /mcp system endpoint from
 * a raw bearer token. Shared by rootMcpAuth (the Express gate on /mcp) and
 * mcp-server.ts's system-scope handlers (which re-derive it per JSON-RPC
 * call, the same "never trust a cached session-level grant" posture
 * proxy.ts already applies to isToolInKeyScope).
 *
 * Deliberately has NO "no auth material configured => allow all" fallback —
 * unlike evaluateMcpAuth's data-plane check, a null return here always means
 * "no system access," even on a fresh install with zero keys minted yet.
 * The one bypass is the global AUTH_DISABLED dev/test escape hatch, which
 * already short-circuits every other auth path in this codebase (adminAuth,
 * mcpAuth) — honoured here for parity, not a new hole.
 */
export function resolveSystemRole(token: string | undefined): SystemAuthResult | null {
  if (config.authDisabled) return { role: "admin", elevated: true, keyId: null, isEnvBearer: true };
  if (!token) return null;

  if (config.adminApiKeys.some((key) => safeCompare(key, token))) {
    return { role: "admin", elevated: true, keyId: null, isEnvBearer: true };
  }

  const rec = resolveMcpKeyByToken(token);
  if (rec && rec.adminRole) {
    touchMcpKeyLastUsed(rec.id);
    return { role: rec.adminRole, elevated: rec.elevated, keyId: rec.id, isEnvBearer: false };
  }

  return null;
}
