import express, { type Request, type Response, type NextFunction } from "express";
import { setupTransports } from "./transports.js";
import { registerRoutes } from "./routes/register.js";
import { introspectionRoutes } from "./routes/introspection.js";
import { docsRoutes } from "./routes/docs.js";
import { startHealthCheckLoop } from "./health.js";
import { config } from "./config.js";
import { rateLimitGlobal, startRateLimiterCleanup } from "./middleware/rate-limiter.js";
import { requestIdMiddleware } from "./middleware/request-id.js";
import { log } from "./logger.js";
import { corsMiddleware } from "./middleware/cors.js";
import { metricsRoutes } from "./routes/metrics.js";
import { startCircuitBreakerCleanup } from "./circuit-breaker.js";
import { checkStartupGuards } from "./security/startup-guards.js";

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
});
if (!guard.ok) {
  log("error", `FATAL: ${guard.reason}`);
  process.exit(1);
}

// Warn when AUTH_DISABLED is allowed via escape hatch
if (config.authDisabled && process.env.NODE_ENV !== "development" && process.env.ALLOW_UNSAFE_AUTH_DISABLED === "true") {
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

// Self-health endpoint
const startedAt = Date.now();
app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    uptime_seconds: Math.floor((Date.now() - startedAt) / 1000),
  });
});

// Health check loop
const stopHealthChecks = startHealthCheckLoop();

// Background cleanup loops
const stopCircuitBreakerCleanup = startCircuitBreakerCleanup();
const stopRateLimiterCleanup = startRateLimiterCleanup();

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
  const rawStatus = typeof errObj.status === "number" ? errObj.status : typeof errObj.statusCode === "number" ? errObj.statusCode : 500;
  const status = rawStatus >= 400 && rawStatus <= 599 ? rawStatus : 500;
  const is5xx = status >= 500;
  const code: string = typeof errObj.code === "string" ? errObj.code : is5xx ? "INTERNAL_ERROR" : "BAD_REQUEST";
  const message: string = is5xx
    ? "Internal server error"
    : typeof (err instanceof Error ? err.message : errObj.message) === "string" && (err instanceof Error ? err.message : String(errObj.message)).length < 500
      ? (err instanceof Error ? err.message : String(errObj.message))
      : "Bad request";
  res.setHeader("Content-Type", "application/json");
  res.status(status).json({ error: { code, message, request_id: requestId ?? null } });
});

const redactedConfig: Record<string, unknown> = { ...(config as unknown as Record<string, unknown>) };
for (const key of Object.keys(redactedConfig)) {
  if (/apiKeys$/i.test(key)) {
    const arr = redactedConfig[key] as unknown[];
    redactedConfig[key] = `<redacted: ${arr.length} keys>`;
  }
}
log("info", "Active configuration", redactedConfig);
const server = app.listen(config.port, () => {
  log("info", "MCP REST Bridge started", { port: config.port });
});

// Graceful shutdown
async function gracefulShutdown(signal: string) {
  log("info", "Graceful shutdown initiated", { signal });
  stopHealthChecks();
  stopCircuitBreakerCleanup();
  stopRateLimiterCleanup();
  cleanupTransports();
  server.close(() => process.exit(0));
  // Fallback: force exit after configured timeout
  setTimeout(() => process.exit(1), config.shutdownForceExitMs);
}

process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
