/**
 * Process entrypoint — opens the database, runs the bootstrap side-effects,
 * then constructs the Express app via `createApp()` and binds it to a port.
 *
 * `createApp()` (in `src/server.ts`) holds the entire HTTP wiring. Anything
 * that has to happen exactly once at process boot — DB open / migrations,
 * bootstrap admin user, hydration caches, fatal-config check, background
 * loops, `app.listen`, graceful shutdown — stays here, so a test can call
 * `createApp()` to get a fully-wired but un-listening app instance without
 * paying for the boot side-effects.
 */
import express, { type Request, type Response, type NextFunction } from "express";
import { existsSync } from "fs";
import { resolve } from "path";
import { getActiveSessionCount } from "./mcp/transports.js";
import { startHealthCheckLoop } from "./observability/health.js";
import { config } from "./config.js";
import { log } from "./logger.js";
import { checkStartupGuards } from "./security/startup-guards.js";
import { isMcpDataPlaneOpen } from "./middleware/auth.js";
import { validateEnvOrWarn, validateEnvStrict } from "./config-schema.js";
import { getDb } from "./db/connection.js";
import { bootstrapAdminUser } from "./security/bootstrap-admin.js";
import {
  loadWsProxyTargets,
  handleWsProxyUpgrade,
  startWsProxyRevalidationLoop,
  closeAllWsProxyConnections,
} from "./ws-proxy.js";
import { startAlertLoop } from "./observability/alerts.js";
import { startScheduleLoop } from "./admin/entities/schedules.js";
import { initBundles } from "./admin/tool-composition/bundles.js";
import { initComposites } from "./admin/tool-composition/composites.js";
import { startLeaderElection } from "./db/leader-lease.js";
import { startPeriodicSweep } from "./lib/leader-loop.js";
import { flush as flushTraces } from "./observability/tracing.js";
import { registry } from "./mcp/registry.js";
import { startCircuitBreakerCleanup } from "./middleware/circuit-breaker.js";
import { startRateLimiterCleanup } from "./middleware/rate-limiter.js";
import { createApp } from "./server.js";
import { errorMessage } from "./lib/error-message.js";

// ─── Persistence ──────────────────────────────────────────────────────────────
// Opens the SQLite handle and applies any pending migrations before anything
// else (including the Registry) can touch it.
getDb();
await bootstrapAdminUser();
// Bundles are purely admin-authored (no external "register" actor pushes
// them live the way clients do), so they must be hydrated from SQLite here.
initBundles();
// Composite (macro) tools are likewise admin-authored — hydrate the cache.
initComposites();
// WS proxy targets are likewise admin-authored — hydrate the cache.
loadWsProxyTargets();

// ─── Startup safety checks ───────────────────────────────────────────────────

// CORS mode log — emitted before any listener is bound so operators see it
// even if a later check causes process.exit.
{
  const isWildcard = config.corsOrigins[0] === "*";
  const corsMode = isWildcard ? "wildcard" : "allowlist";
  log("info", "CORS configuration resolved", {
    mode: corsMode,
    origins: config.corsOrigins,
    credentials: config.corsAllowCredentials,
  });
}

const guard = checkStartupGuards({
  authDisabled: config.authDisabled,
  corsOrigins: config.corsOrigins,
  trustProxy: config.trustProxy,
  nodeEnv: process.env.NODE_ENV,
  sessionCookieSecure: config.sessionCookieSecure,
  jwtJwksUrl: config.jwtJwksUrl,
  jwtAudience: config.jwtAudience,
});
if (!guard.ok) {
  log("error", `FATAL: ${guard.reason}`);
  process.exit(1);
}

// Warn when the JWT-audience guard is bypassed via escape hatch
if (
  config.jwtJwksUrl &&
  !config.jwtAudience &&
  process.env.NODE_ENV !== "development" &&
  process.env.ALLOW_UNSAFE_JWT_NO_AUDIENCE === "true"
) {
  log(
    "warn",
    "JWT_JWKS_URL is set without JWT_AUDIENCE outside development — any token validly signed by the JWKS " +
      "is accepted regardless of audience. Continuing because ALLOW_UNSAFE_JWT_NO_AUDIENCE=true.",
  );
}

// Warn when AUTH_DISABLED is allowed via escape hatch
if (
  config.authDisabled &&
  process.env.NODE_ENV !== "development" &&
  process.env.ALLOW_UNSAFE_AUTH_DISABLED === "true"
) {
  log(
    "warn",
    "AUTH_DISABLED is true outside development environment — all endpoints unauthenticated. " +
      "Refusing to start unless ALLOW_UNSAFE_AUTH_DISABLED=true also set. " +
      "Continuing because ALLOW_UNSAFE_AUTH_DISABLED=true.",
  );
}

// ─── Express app (full wiring via createApp) ────────────────────────────────

const { app, cleanupTransports } = createApp();

// ─── Admin UI (Vue SPA) ─────────────────────────────────────────────────────
// Sibling namespace to /admin-api, not nested under it — Express mount-path
// matching respects segment boundaries ("/admin" never matches "/admin-api"),
// so there's no registration-order ambiguity between the two.
//
// Mounted AFTER createApp() because it depends on the admin-ui/dist directory
// existing on disk, which tests usually don't have. Tests that need the
// admin UI mount it themselves.
{
  const adminUiDist = resolve(import.meta.dirname, "../admin-ui/dist");
  if (existsSync(adminUiDist)) {
    app.use("/admin", express.static(adminUiDist));
    // SPA fallback for client-side routes (e.g. /admin/clients/foo on a hard
    // refresh) — explicit middleware rather than a wildcard route pattern,
    // sidestepping Express 5 / path-to-regexp v8 wildcard syntax entirely.
    app.use("/admin", (req: Request, res: Response, next: NextFunction) => {
      if (req.method === "GET") {
        res.sendFile(resolve(adminUiDist, "index.html"));
        return;
      }
      next();
    });
  } else {
    log("warn", "admin-ui/dist not found — the admin UI is not being served. Run `bun run build` in admin-ui/ first.");
  }
}

// Leader election (must start before the health-check loop, which consults isLeader())
const stopLeaderElection = startLeaderElection();

// Health check loop
const stopHealthChecks = startHealthCheckLoop();

// Background cleanup loops
const stopCircuitBreakerCleanup = startCircuitBreakerCleanup();
const stopRateLimiterCleanup = startRateLimiterCleanup();

// Alert evaluation loop (leader-only, gated inside the loop)
const stopAlerts = startAlertLoop();

// Maintenance-schedule evaluator (leader-only, gated inside the loop)
const stopSchedules = startScheduleLoop();

// Cross-instance registry reconciliation (opt-in for HA; every instance syncs
// its own view from SQLite so registrations/removals on peers propagate).
let stopRegistrySync: () => void = () => {};
if (config.registrySyncEnabled) {
  // The inner .catch keeps the existing warn-level message; startPeriodicSweep
  // provides the shared setInterval + unref + stop() scaffold.
  stopRegistrySync = startPeriodicSweep(() => {
    void registry
      .reconcileFromDb()
      .catch((err) => log("warn", "Registry reconciliation failed", { error: errorMessage(err) }));
  }, config.registrySyncIntervalMs);
  log("info", "Registry cross-instance sync enabled", { intervalMs: config.registrySyncIntervalMs });
}

// Config fields holding a raw secret value rather than a name/label/count —
// e.g. vaultTransitKeyName and secretsProvider are NOT secrets and must stay
// visible for operators to confirm at boot; secretEncryptionKey/vaultToken are.
const REDACT_EXACT_KEYS = new Set(["secretEncryptionKey", "vaultToken"]);
const redactedConfig: Record<string, unknown> = { ...(config as unknown as Record<string, unknown>) };
for (const key of Object.keys(redactedConfig)) {
  if (/apiKeys$/i.test(key)) {
    const arr = redactedConfig[key] as unknown[];
    redactedConfig[key] = `<redacted: ${arr.length} keys>`;
  } else if (/password/i.test(key) && redactedConfig[key]) {
    redactedConfig[key] = "<redacted>";
  } else if (REDACT_EXACT_KEYS.has(key) && redactedConfig[key]) {
    redactedConfig[key] = "<redacted>";
  } else if (
    /(secret|token|passwd|credential|private[_-]?key)/i.test(key) &&
    !/(name|provider|kind|type|count|id|ids|enabled|url|at|ms)$/i.test(key) &&
    redactedConfig[key]
  ) {
    // Generic fallback so a future secret-ish config field (oidcClientSecret,
    // slackToken, …) is redacted even before it's added to the exact list. The
    // safe-suffix guard keeps non-secret fields like secretsProvider visible.
    redactedConfig[key] = "<redacted>";
  } else if (typeof redactedConfig[key] === "string" && /^https?:\/\/[^/]*@/.test(redactedConfig[key] as string)) {
    // Strip credentials embedded in a configured URL (e.g. https://user:pass@host
    // in JWT_JWKS_URL / AUDIT_SINK_URL / VAULT_ADDR) so they never hit the log.
    redactedConfig[key] = (redactedConfig[key] as string).replace(/^(https?:\/\/)[^/@]*@/, "$1<redacted>@");
  }
}
// Env validation — surface typos and out-of-range values at boot. Warn-only by
// default (dev ergonomic); production can promote via STRICT_CONFIG=production,
// which aborts boot instead of just logging.
validateEnvOrWarn();
try {
  validateEnvStrict();
} catch (err) {
  log("error", `FATAL: ${errorMessage(err)}`);
  process.exit(1);
}
log("info", "Active configuration", redactedConfig);

// Fail-open guard: warn loudly if the MCP data plane is unauthenticated (no
// MCP_API_KEYS, managed keys, or inbound JWT, and REQUIRE_MCP_AUTH unset) — every
// backend tool on /mcp/:client, /mcp-custom/:bundle, and the WS proxy would then
// be callable by anyone. Emitted last so operators can't miss it.
if (isMcpDataPlaneOpen()) {
  log("warn", "MCP data plane is UNAUTHENTICATED — set MCP_API_KEYS or REQUIRE_MCP_AUTH=true", {
    registeredClients: registry.listClients().length,
    affectedEndpoints: ["/mcp/:client", "/mcp-custom/:bundle", "/ws-proxy/*"],
    detail:
      "No MCP_API_KEYS, DB-managed keys, or inbound JWT are configured, so backend tools on the " +
      "data-plane endpoints accept any caller. Mint an MCP key or set REQUIRE_MCP_AUTH=true to fail closed.",
  });
}

const server = app.listen(config.port, () => {
  log("info", "MCP REST Bridge started", { port: config.port });
});

// WS proxy: the only Upgrade path in this codebase (MCP SSE uses plain GET,
// not Upgrade), so any other upgrade request is rejected outright.
const stopWsProxyRevalidation = startWsProxyRevalidationLoop();
server.on("upgrade", (req, socket, head) => {
  if (req.url?.startsWith("/ws-proxy/")) {
    handleWsProxyUpgrade(req, socket, head).catch(() => socket.destroy());
    return;
  }
  socket.destroy();
});

// Graceful shutdown
let shuttingDown = false;
async function gracefulShutdown(signal: string) {
  // A second signal (double SIGINT, or SIGINT then SIGTERM) must not re-run every
  // stop*() nor install a second force-exit timer — the first shutdown is already
  // in progress.
  if (shuttingDown) return;
  shuttingDown = true;
  log("info", "Graceful shutdown initiated", { signal });
  stopHealthChecks();
  stopLeaderElection();
  stopCircuitBreakerCleanup();
  stopRateLimiterCleanup();
  stopAlerts();
  stopSchedules();
  stopRegistrySync();
  stopWsProxyRevalidation();
  closeAllWsProxyConnections();
  void flushTraces();
  cleanupTransports();
  server.close(() => process.exit(0));
  // Fallback: force exit after configured timeout
  const forceTimer = setTimeout(() => {
    log("warn", "Force exit triggered after transport cleanup timeout", {
      activeSessions: getActiveSessionCount(),
    });
    process.exit(1);
  }, config.shutdownForceExitMs);
  if (forceTimer.unref) forceTimer.unref();
}

process.on("SIGINT", () => {
  void gracefulShutdown("SIGINT");
});
process.on("SIGTERM", () => {
  void gracefulShutdown("SIGTERM");
});

// Last-resort safety net: a stray unhandled promise rejection (e.g. a
// best-effort MCP notification whose target transport closed mid-stream) must
// be logged, never crash the gateway or vanish silently. The hot paths already
// .catch() their own fire-and-forget sends (notifyToolsChanged, onProgress);
// this only backstops anything that slips through, so it logs and keeps serving
// rather than exiting.
process.on("unhandledRejection", (reason) => {
  log("error", "Unhandled promise rejection", {
    err: reason instanceof Error ? { message: reason.message, stack: reason.stack, name: reason.name } : reason,
  });
});
