import express, { type Request, type Response, type NextFunction } from "express";
import { existsSync } from "fs";
import { resolve } from "path";
import { setupTransports, getActiveSessionCount } from "./mcp/transports.js";
import { registerRoutes } from "./routes/register.js";
import { introspectionRoutes } from "./routes/introspection.js";
import { docsRoutes } from "./routes/docs.js";
import { startHealthCheckLoop } from "./observability/health.js";
import { config } from "./config.js";
import { rateLimitGlobal, startRateLimiterCleanup } from "./middleware/rate-limiter.js";
import { requestIdMiddleware } from "./middleware/request-id.js";
import { log } from "./logger.js";
import { corsMiddleware } from "./middleware/cors.js";
import { metricsRoutes } from "./routes/metrics.js";
import { startCircuitBreakerCleanup } from "./middleware/circuit-breaker.js";
import { checkStartupGuards } from "./security/startup-guards.js";
import { validateEnvOrWarn } from "./config-schema.js";
import { enforceJsonDepth } from "./middleware/json-depth.js";
import { getDb } from "./db/connection.js";
import { bootstrapAdminUser } from "./security/bootstrap-admin.js";
import { authRoutes } from "./routes/auth.js";
import { authOidcRoutes } from "./routes/auth-oidc.js";
import { adminRoutes } from "./routes/admin.js";
import { bundleRoutes } from "./routes/bundles.js";
import { installLinkRoutes } from "./routes/install-links.js";
import { mcpKeyRoutes } from "./routes/mcp-keys.js";
import { upstreamAuthRoutes } from "./routes/upstream-auth.js";
import { discoveryRoutes } from "./routes/discovery.js";
import { catalogRoutes } from "./routes/catalog.js";
import { wsProxyAdminRoutes } from "./routes/ws-proxy-admin.js";
import {
  loadWsProxyTargets,
  handleWsProxyUpgrade,
  startWsProxyRevalidationLoop,
  closeAllWsProxyConnections,
} from "./ws-proxy.js";
import { usageRoutes } from "./routes/usage.js";
import { alertRoutes } from "./routes/alerts.js";
import { startAlertLoop } from "./observability/alerts.js";
import { configIoRoutes } from "./routes/config-io.js";
import { backupRoutes } from "./routes/backup.js";
import { policyRoutes } from "./routes/policies.js";
import { tagRoutes } from "./routes/tags.js";
import { consumerRoutes } from "./routes/consumers.js";
import { compositeRoutes } from "./routes/composites.js";
import { scheduleRoutes } from "./routes/schedules.js";
import { teamRoutes } from "./routes/teams.js";
import { tracesRoutes } from "./routes/traces.js";
import { startScheduleLoop } from "./admin/entities/schedules.js";
import { initBundles } from "./admin/tool-composition/bundles.js";
import { initComposites } from "./admin/tool-composition/composites.js";
import { startLeaderElection } from "./db/leader-lease.js";
import { flush as flushTraces } from "./observability/tracing.js";
import { registry } from "./mcp/registry.js";

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
});
if (!guard.ok) {
  log("error", `FATAL: ${guard.reason}`);
  process.exit(1);
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

// ─── Express app ─────────────────────────────────────────────────────────────

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", config.trustProxy);
if (config.trustProxy) {
  log("warn", "TRUST_PROXY is enabled — ensure this server is behind a trusted reverse proxy");
}
app.use(express.json({ limit: "64kb", strict: true }));
app.use(enforceJsonDepth(config.maxJsonDepth));
app.use(requestIdMiddleware);
// ─── Baseline security headers ────────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  // HSTS only if request was HTTPS (trust proxy aware)
  if (req.secure || req.headers["x-forwarded-proto"] === "https") {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
  next();
});
app.use(corsMiddleware);
app.use(rateLimitGlobal(config.rateLimitGlobal));

// MCP transports (Streamable HTTP + SSE legacy)
const cleanupTransports = setupTransports(app);

// REST endpoints
registerRoutes(app);
introspectionRoutes(app);
docsRoutes(app);
metricsRoutes(app);
authRoutes(app);
authOidcRoutes(app);
adminRoutes(app);
bundleRoutes(app);
installLinkRoutes(app);
mcpKeyRoutes(app);
upstreamAuthRoutes(app);
discoveryRoutes(app);
catalogRoutes(app);
wsProxyAdminRoutes(app);
usageRoutes(app);
alertRoutes(app);
configIoRoutes(app);
backupRoutes(app);
policyRoutes(app);
tagRoutes(app);
consumerRoutes(app);
compositeRoutes(app);
scheduleRoutes(app);
teamRoutes(app);
tracesRoutes(app);

// ─── Admin UI (Vue SPA) ─────────────────────────────────────────────────────
// Sibling namespace to /admin-api, not nested under it — Express mount-path
// matching respects segment boundaries ("/admin" never matches "/admin-api"),
// so there's no registration-order ambiguity between the two.
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

// Self-health endpoint
const startedAt = Date.now();
app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    uptime_seconds: Math.floor((Date.now() - startedAt) / 1000),
  });
});

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
  const t = setInterval(() => {
    registry
      .reconcileFromDb()
      .catch((err) =>
        log("warn", "Registry reconciliation failed", { error: err instanceof Error ? err.message : String(err) }),
      );
  }, config.registrySyncIntervalMs);
  if (t.unref) t.unref();
  stopRegistrySync = () => clearInterval(t);
  log("info", "Registry cross-instance sync enabled", { intervalMs: config.registrySyncIntervalMs });
}

// ─── Global error handler ─────────────────────────────────────────────────────
app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
  if (res.headersSent) {
    _next(err);
    return;
  }
  const requestId: string | undefined = res.locals.requestId as string | undefined;
  log("error", "Unhandled request error", {
    request_id: requestId,
    err: err instanceof Error ? { message: err.message, stack: err.stack, name: err.name } : err,
  });
  const errObj = err as Record<string, unknown>;
  const rawStatus =
    typeof errObj.status === "number" ? errObj.status : typeof errObj.statusCode === "number" ? errObj.statusCode : 500;
  const status = rawStatus >= 400 && rawStatus <= 599 ? rawStatus : 500;
  const is5xx = status >= 500;
  const code: string = typeof errObj.code === "string" ? errObj.code : is5xx ? "INTERNAL_ERROR" : "BAD_REQUEST";
  const message: string = is5xx
    ? "Internal server error"
    : typeof (err instanceof Error ? err.message : errObj.message) === "string" &&
        (err instanceof Error ? err.message : String(errObj.message)).length < 500
      ? err instanceof Error
        ? err.message
        : String(errObj.message)
      : "Bad request";
  res.setHeader("Content-Type", "application/json");
  res.status(status).json({ error: { code, message, request_id: requestId ?? null } });
});

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
  }
}
// Env validation — surface typos and out-of-range values at boot. Warn-only by
// default (dev ergonomic); production can promote via STRICT_CONFIG=production.
validateEnvOrWarn();
log("info", "Active configuration", redactedConfig);
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
async function gracefulShutdown(signal: string) {
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
      inflightRequests: 0,
    });
    process.exit(1);
  }, config.shutdownForceExitMs);
  if (forceTimer.unref) forceTimer.unref();
}

process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
