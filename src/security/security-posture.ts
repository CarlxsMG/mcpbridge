/**
 * "Is this instance running with a hole in it?" — evaluated from live config,
 * for the admin API and the admin UI's banner.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * The gateway already knows all of this at boot. `checkStartupGuards` refuses
 * to start on the genuinely dangerous combinations, and `src/index.ts` logs a
 * loud warning when the MCP data plane is unauthenticated. But a warning on
 * stdout is invisible to the person who needs it: an operator running this in
 * Docker or Kubernetes reads a dashboard, not the first 40 lines of a container
 * log from three weeks ago. A gateway could be serving every backend tool to
 * anonymous callers and nothing in the product would say so.
 *
 * What is reported here is deliberately narrow — the conditions that are
 * ALLOWED to keep running:
 *
 *   - `mcp_data_plane_open` has no startup guard at all, by design: a fresh
 *     install with no keys yet must be usable, and minting the first key locks
 *     it down automatically. That grace period is exactly what can be forgotten.
 *   - The rest are refused outside development by `checkStartupGuards`, so
 *     seeing one here means either NODE_ENV=development or a deliberate
 *     `ALLOW_UNSAFE_*` escape hatch. `tolerated` records which, because
 *     "insecure but it's my laptop" and "insecure in production because someone
 *     set an env var eight months ago" want very different reactions.
 *
 * Deliberately NOT reported: anything requiring a probe (TLS termination,
 * upstream reachability) or a judgement call about the deployment. This reads
 * config and in-memory state only, so it is cheap enough to call on every
 * admin-UI navigation and can never itself fail.
 */
import { config } from "../config.js";
import { isMcpDataPlaneOpen } from "../middleware/auth.js";

/**
 * `critical` — an authentication boundary is fully open right now.
 * `warning` — a real weakening of a boundary that still has other protection.
 * `info` — a capability is unavailable; nothing is exposed.
 */
export type PostureSeverity = "critical" | "warning" | "info";

/** Why a condition that `checkStartupGuards` normally refuses is running anyway. */
export type PostureTolerated = "development" | "escape_hatch" | null;

export interface PostureFinding {
  /** Stable id — the admin UI translates on this (`components.security_banner.checks.<id>`), never on `summary`. */
  id: string;
  severity: PostureSeverity;
  /** English one-liner for non-UI consumers (curl, scripts). The UI prefers its own translation. */
  summary: string;
  /** Which escape hatch (if any) is keeping this alive; null when no guard covers the condition. */
  tolerated: PostureTolerated;
  /** Env var an operator would change to clear it. */
  remediation: string;
}

export interface SecurityPosture {
  findings: PostureFinding[];
  /** Highest severity present, or null when there is nothing to report. */
  worst: PostureSeverity | null;
}

/** True when the process is running in development mode, where the startup guards stand down. */
function isDev(): boolean {
  return process.env.NODE_ENV === "development";
}

/**
 * Which reason kept a guarded condition alive. `development` wins when both
 * apply: it is the more likely explanation and the less alarming one, and an
 * escape hatch set on a dev box is not news.
 */
function toleratedBy(escapeHatch: string): PostureTolerated {
  if (isDev()) return "development";
  return process.env[escapeHatch] === "true" ? "escape_hatch" : null;
}

const SEVERITY_ORDER: Record<PostureSeverity, number> = { info: 0, warning: 1, critical: 2 };

export function evaluateSecurityPosture(): SecurityPosture {
  const findings: PostureFinding[] = [];

  if (isMcpDataPlaneOpen()) {
    findings.push({
      id: "mcp_data_plane_open",
      severity: "critical",
      summary:
        "The MCP data plane accepts any caller — every backend tool on /mcp/:client, " +
        "/mcp-custom/:bundle and the WS proxy is callable without credentials.",
      // No startup guard covers this one: an instance with no keys yet has to be
      // usable, so it is "tolerated" by design rather than by an escape hatch.
      tolerated: null,
      remediation: "Mint an MCP API key, or set REQUIRE_MCP_AUTH=true.",
    });
  }

  if (config.authDisabled) {
    findings.push({
      id: "auth_disabled",
      severity: "critical",
      summary: "AUTH_DISABLED is on — every endpoint, including the admin API, is unauthenticated.",
      tolerated: toleratedBy("ALLOW_UNSAFE_AUTH_DISABLED"),
      remediation: "Unset AUTH_DISABLED.",
    });
  }

  if (config.corsOrigins[0] === "*") {
    findings.push({
      id: "cors_wildcard",
      severity: config.corsAllowCredentials ? "critical" : "warning",
      summary: config.corsAllowCredentials
        ? "CORS allows any origin AND credentials — any site a signed-in admin visits can drive the admin API as them."
        : "CORS allows any origin.",
      tolerated: toleratedBy("ALLOW_UNSAFE_CORS_WILDCARD"),
      remediation: "Set CORS_ORIGINS to an explicit list of origins.",
    });
  }

  if (!config.sessionCookieSecure) {
    findings.push({
      id: "session_cookie_insecure",
      severity: "warning",
      summary: "Admin session cookies are sent without the Secure flag, so plain HTTP can carry them.",
      tolerated: toleratedBy("ALLOW_UNSAFE_INSECURE_SESSION_COOKIE"),
      remediation: "Serve over HTTPS and unset SESSION_COOKIE_SECURE=false.",
    });
  }

  if (config.jwtJwksUrl && !config.jwtAudience) {
    findings.push({
      id: "jwt_no_audience",
      severity: "warning",
      summary:
        "Inbound JWT auth accepts any token signed by the JWKS, whoever it was minted for — " +
        "in a shared IdP that is a cross-audience privilege grant.",
      tolerated: toleratedBy("ALLOW_UNSAFE_JWT_NO_AUDIENCE"),
      remediation: "Set JWT_AUDIENCE.",
    });
  }

  if (config.trustProxy === true) {
    findings.push({
      id: "trust_proxy_boolean",
      severity: "warning",
      summary:
        "TRUST_PROXY=true trusts the X-Forwarded-For of every caller, so a client can spoof its IP " +
        "past the per-IP rate limits.",
      tolerated: isDev() ? "development" : null,
      remediation: "Set TRUST_PROXY to a CIDR list, a named preset, or a hop count.",
    });
  }

  if (!config.secretEncryptionKey && config.secretsProvider === "local") {
    findings.push({
      id: "secret_box_unset",
      severity: "info",
      summary: "No secret box is configured, so upstream credentials and bundle install links cannot be stored.",
      tolerated: null,
      remediation: "Set SECRET_ENCRYPTION_KEY (32 bytes, base64) or configure an external secrets provider.",
    });
  }

  const worst = findings.reduce<PostureSeverity | null>(
    (acc, f) => (acc === null || SEVERITY_ORDER[f.severity] > SEVERITY_ORDER[acc] ? f.severity : acc),
    null,
  );

  return { findings, worst };
}
