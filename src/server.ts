/**
 * Express app wiring, extracted from `src/index.ts` so tests (and future
 * e2e harnesses) can build a fully-configured app instance without going
 * through the long-running bootstrap path in `src/index.ts`
 * (DB migration, leader election, background loops, `app.listen`).
 *
 * What `createApp()` does:
 *   1. Construct an `express()` instance, set `trust proxy`, register the
 *      global middleware chain (JSON body, JSON depth, request-id, the
 *      baseline security-headers middleware, CORS, the global rate limit).
 *   2. Mount the MCP transports (Streamable HTTP + the legacy SSE route
 *      via `setupTransports`).
 *   3. Mount every REST router (admin, bundles, policies, …) and the
 *      `/livez` + `/readyz` + `/health` trio.
 *   4. Register the global JSON error envelope at the very end so it
 *      catches anything the routers throw.
 *
 * What `createApp()` does NOT do — those stay in `src/index.ts`:
 *   - DB open / migrations (must happen once, before any handler touches it)
 *   - bootstrap admin user (only consumes env vars on first run)
 *   - `checkStartupGuards` (fatal-exits the process on misconfig)
 *   - Background loops (leader election, health-check, alert eval, …)
 *   - `app.listen` + graceful shutdown wiring
 *   - The admin UI static fallback (depends on `admin-ui/dist` existing
 *     and produces HTML responses — neither is wanted in handler tests)
 *
 * `setupTransports` registers a cleanup callback for the active transport
 * sessions. We surface it as part of the return so the caller (only
 * `src/index.ts` today) can hook it into its graceful-shutdown sequence;
 * tests can ignore it.
 */
import express, { type Express, type Request, type Response, type NextFunction } from "express";
import { config } from "./config.js";
import { requestIdMiddleware } from "./middleware/request-id.js";
import { enforceJsonDepth } from "./middleware/json-depth.js";
import { corsMiddleware } from "./middleware/cors.js";
import { rateLimitGlobal } from "./middleware/rate-limiter.js";
import { log } from "./logger.js";
import { setupTransports } from "./mcp/transports.js";
import { registerRoutes } from "./routes/register.js";
import { introspectionRoutes } from "./routes/introspection.js";
import { docsRoutes } from "./routes/docs.js";
import { metricsRoutes } from "./routes/metrics.js";
import { healthRoutes } from "./routes/health.js";
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
import { usageRoutes } from "./routes/usage.js";
import { alertRoutes } from "./routes/alerts.js";
import { configIoRoutes } from "./routes/config-io.js";
import { backupRoutes } from "./routes/backup.js";
import { policyRoutes } from "./routes/policies.js";
import { tagRoutes } from "./routes/tags.js";
import { consumerRoutes } from "./routes/consumers.js";
import { compositeRoutes } from "./routes/composites.js";
import { scheduleRoutes } from "./routes/schedules.js";
import { teamRoutes } from "./routes/teams.js";
import { tracesRoutes } from "./routes/traces.js";

export interface CreateAppResult {
  app: Express;
  /** Cleanup hook for the active MCP transport sessions. Pass to graceful shutdown. */
  cleanupTransports: () => void;
}

export function createApp(): CreateAppResult {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", config.trustProxy);
  if (config.trustProxy) {
    log("warn", "TRUST_PROXY is enabled — ensure this server is behind a trusted reverse proxy");
  }
  app.use(express.json({ limit: "64kb", strict: true }));
  app.use(enforceJsonDepth(config.maxJsonDepth));
  app.use(requestIdMiddleware);

  // ─── Baseline security headers ────────────────────────────────────────────
  app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    // Content-Security-Policy — a single policy applied to every response.
    // The admin UI (Vue 3 SPA) needs 'self' for script/connect/img, plus
    // 'unsafe-inline' for style because Vue components emit dynamic inline
    // styles; the admin API only ever returns JSON, so CSP doesn't constrain
    // it in practice. Tightening further would mean coordinating nonces
    // with the admin-ui build, which is out of scope for now.
    res.setHeader(
      "Content-Security-Policy",
      [
        "default-src 'none'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data:",
        "font-src 'self'",
        "connect-src 'self'",
        "frame-ancestors 'none'",
        "form-action 'self'",
        "base-uri 'none'",
        "object-src 'none'",
      ].join("; "),
    );
    // Permissions-Policy — turn off every powerful feature the admin UI
    // doesn't legitimately need. The list is the OWASP "secure default" set:
    // a future feature that does need one of these can re-enable it locally.
    res.setHeader(
      "Permissions-Policy",
      "accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()",
    );
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
  healthRoutes(app);
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

  // ─── Global error handler ────────────────────────────────────────────────
  // Registered LAST so it catches anything the routers above throw. Shape
  // matches the per-route `sendError` envelope so downstream consumers
  // (admin UI, ops dashboards) get a uniform error response.
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
      typeof errObj.status === "number"
        ? errObj.status
        : typeof errObj.statusCode === "number"
          ? errObj.statusCode
          : 500;
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

  return { app, cleanupTransports };
}
