import express from "express";
import { setupTransports } from "./transports.js";
import { registerRoutes } from "./routes/register.js";
import { introspectionRoutes } from "./routes/introspection.js";
import { docsRoutes } from "./routes/docs.js";
import { startHealthCheckLoop } from "./health.js";
import { config } from "./config.js";
import { rateLimitGlobal } from "./middleware/rate-limiter.js";
import { requestIdMiddleware } from "./middleware/request-id.js";
import { log } from "./logger.js";
import { corsMiddleware } from "./middleware/cors.js";
import { metricsRoutes } from "./routes/metrics.js";

const app = express();
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

// Health check loop
const stopHealthChecks = startHealthCheckLoop();

log("info", "Active configuration", config as unknown as Record<string, unknown>);
const server = app.listen(config.port, () => {
  log("info", "MCP REST Bridge started", { port: config.port });
});

// Graceful shutdown
async function gracefulShutdown(signal: string) {
  log("info", "Graceful shutdown initiated", { signal });
  stopHealthChecks();
  cleanupTransports();
  server.close(() => process.exit(0));
  // Fallback: force exit after 10s
  setTimeout(() => process.exit(1), 10_000);
}

process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
