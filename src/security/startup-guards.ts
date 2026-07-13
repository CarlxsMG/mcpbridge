/** Startup safety checks extracted for unit-testability. */

export interface StartupGuardEnv {
  authDisabled: boolean;
  corsOrigins: string[] | string;
  trustProxy: unknown;
  nodeEnv: string | undefined;
  sessionCookieSecure: boolean;
  jwtJwksUrl: string | undefined;
  jwtAudience: string | undefined;
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
 *  4. SESSION_COOKIE_SECURE=false outside development (unless ALLOW_UNSAFE_INSECURE_SESSION_COOKIE=true)
 *  5. JWT_JWKS_URL set without JWT_AUDIENCE outside development (unless ALLOW_UNSAFE_JWT_NO_AUDIENCE=true)
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

  // ── 4. Insecure session cookie guard ──────────────────────────────────────
  if (!env.sessionCookieSecure && !isDev) {
    const allowUnsafe = process.env.ALLOW_UNSAFE_INSECURE_SESSION_COOKIE === "true";
    if (!allowUnsafe) {
      return {
        ok: false,
        reason:
          "SESSION_COOKIE_SECURE=false outside development — admin session cookies would be sent over " +
          "plain HTTP. Refusing to start unless ALLOW_UNSAFE_INSECURE_SESSION_COOKIE=true also set.",
      };
    }
  }

  // ── 5. JWT audience-binding guard ─────────────────────────────────────────
  // With inbound JWT auth enabled (JWT_JWKS_URL set) but no JWT_AUDIENCE, any
  // token validly signed by a key in that JWKS is accepted regardless of who it
  // was minted for. In a shared IdP (one tenant issuing tokens for many apps) a
  // token for an unrelated app would be accepted as a gateway data-plane
  // credential — a cross-audience privilege grant. Require the audience binding.
  if (env.jwtJwksUrl && !env.jwtAudience && !isDev) {
    const allowUnsafe = process.env.ALLOW_UNSAFE_JWT_NO_AUDIENCE === "true";
    if (!allowUnsafe) {
      return {
        ok: false,
        reason:
          "JWT_JWKS_URL is set without JWT_AUDIENCE outside development — any token validly signed by the " +
          "JWKS is accepted regardless of its intended audience (a cross-audience privilege grant in a shared " +
          "IdP). Refusing to start unless JWT_AUDIENCE is set (or ALLOW_UNSAFE_JWT_NO_AUDIENCE=true also set).",
      };
    }
  }

  return { ok: true };
}
