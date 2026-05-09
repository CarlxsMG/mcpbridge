/** Startup safety checks extracted for unit-testability. */

export interface StartupGuardEnv {
  authDisabled: boolean;
  corsOrigins: string[] | string;
  trustProxy: unknown;
  nodeEnv: string | undefined;
}

export type GuardResult = { ok: true } | { ok: false; reason: string };

/**
 * Validates the runtime environment against known dangerous configurations.
 *
 * Returns `{ ok: true }` when all checks pass, or `{ ok: false, reason }` on
 * the first violation.  Callers are responsible for calling `process.exit(1)`
 * if they wish to abort startup — this function never calls it directly, which
 * makes it unit-testable without spawning a child process.
 *
 * Guards (evaluated in order):
 *  1. AUTH_DISABLED=true outside development (unless ALLOW_UNSAFE_AUTH_DISABLED=true)
 *  2. CORS wildcard '*' outside development
 *  3. TRUST_PROXY=true (boolean) outside development
 */
export function checkStartupGuards(env: StartupGuardEnv): GuardResult {
  const isDev = env.nodeEnv === "development";

  // ── 1. AUTH_DISABLED guard ────────────────────────────────────────────────
  if (env.authDisabled && !isDev) {
    const allowUnsafe = process.env.ALLOW_UNSAFE_AUTH_DISABLED === "true";
    if (!allowUnsafe) {
      return {
        ok: false,
        reason:
          "AUTH_DISABLED is true outside development environment — all endpoints unauthenticated. " +
          "Refusing to start unless ALLOW_UNSAFE_AUTH_DISABLED=true also set.",
      };
    }
  }

  // ── 2. CORS wildcard guard ────────────────────────────────────────────────
  const origins = Array.isArray(env.corsOrigins) ? env.corsOrigins : [env.corsOrigins];
  if (origins[0] === "*" && !isDev) {
    return {
      ok: false,
      reason:
        "CORS wildcard '*' is active outside the development environment. " +
        "All cross-origin requests will be permitted. " +
        "Restrict CORS_ORIGINS to explicit origins before deploying to production.",
    };
  }

  // ── 3. TRUST_PROXY boolean guard ──────────────────────────────────────────
  if (env.trustProxy === true && !isDev) {
    return {
      ok: false,
      reason:
        "TRUST_PROXY=true (boolean) is unsafe outside development — set TRUST_PROXY to a CIDR list, " +
        "named preset (e.g. 'loopback,linklocal,uniquelocal'), or numeric hop count",
    };
  }

  return { ok: true };
}
