import express from "express";
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

// ─── Startup safety checks ───────────────────────────────────────────────────

if (config.authDisabled && process.env.NODE_ENV !== "development") {
  const allowUnsafe = process.env.ALLOW_UNSAFE_AUTH_DISABLED === "true";
  const msg =
    "AUTH_DISABLED is true outside development environment — all endpoints unauthenticated. " +
    "Refusing to start unless ALLOW_UNSAFE_AUTH_DISABLED=true also set.";
  if (!allowUnsafe) {
    log("error", msg);
    process.exit(1);
  }
  log("warn", msg + " Continuing because ALLOW_UNSAFE_AUTH_DISABLED=true.");
}

// ─── Express app ─────────────────────────────────────────────────────────────

const app = express();
app.set("trust proxy", config.trustProxy);
if (config.trustProxy) {
  log("warn", "TRUST_PROXY is enabled — ensure this server is behind a trusted reverse proxy");
}
app.use(express.json());
app.use(requestIdMiddleware);
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

log("info", "Active configuration", config as unknown as Record<string, unknown>);
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
