import type { Request, Response, Express } from "express";
import { registry } from "../mcp/registry.js";
import { getAllCircuitStates, getAllBreakerStateGauges } from "../middleware/circuit-breaker.js";
import { adminAuth } from "../middleware/auth.js";
import { config } from "../config.js";
import { getRateLimitBucketSizes } from "../middleware/rate-limiter.js";
import {
  metricsRegistry,
  breakerCurrentState,
  registryClients,
  registryToolsTotal,
  rateLimitBuckets,
  getLegacyMetricsSnapshot,
} from "../observability/metrics.js";
import { notFound } from "./http-errors.js";

// ── Prometheus snapshot helpers ───────────────────────────────────────────────

function snapshotGauges(): void {
  // Circuit breaker current states. Reset first: the `client` label is dynamic,
  // so an evicted client's series would otherwise linger at its last value
  // (e.g. 2=open) forever — a permanent false MCPCircuitBreakerOpen alert plus
  // unbounded cardinality. Repopulate only from live breakers.
  breakerCurrentState.reset();
  for (const { client, value } of getAllBreakerStateGauges()) {
    breakerCurrentState.set({ client }, value);
  }

  // Registry client counts by status
  const clients = registry.listClients();
  const healthy = clients.filter((c) => c.status === "healthy").length;
  const degraded = clients.filter((c) => c.status === "degraded").length;
  const unreachable = clients.filter((c) => c.status === "unreachable").length;
  registryClients.set({ status: "healthy" }, healthy);
  registryClients.set({ status: "degraded" }, degraded);
  registryClients.set({ status: "unreachable" }, unreachable);

  // Registry tool index size — read from introspect accessor
  registryToolsTotal.set(
    {},
    clients.reduce((sum, c) => sum + (c.tools?.length ?? 0), 0),
  );

  // Rate limiter bucket sizes
  const sizes = getRateLimitBucketSizes();
  rateLimitBuckets.set({ tier: "global" }, sizes.global);
  rateLimitBuckets.set({ tier: "mcp" }, sizes.mcp);
  rateLimitBuckets.set({ tier: "register" }, sizes.register);
}

// ── Route ─────────────────────────────────────────────────────────────────────

export function metricsRoutes(app: Express): void {
  app.get("/metrics", adminAuth, (_req: Request, res: Response) => {
    if (!config.metricsEnabled) {
      notFound(res, "NOT_FOUND", "Metrics endpoint is disabled");
      return;
    }

    snapshotGauges();

    res.setHeader("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
    res.status(200).send(metricsRegistry.render());
  });

  // Legacy JSON endpoint kept for backwards compat (internal use / health dashboards)
  app.get("/metrics/legacy", adminAuth, (_req: Request, res: Response) => {
    const clients = registry.listClients();
    const healthy = clients.filter((c) => c.status === "healthy").length;
    const snapshot = getLegacyMetricsSnapshot();

    res.json({
      uptime_seconds: snapshot.uptimeSeconds,
      active_sessions: snapshot.sessions,
      registered_clients: {
        total: clients.length,
        healthy,
        unreachable: clients.length - healthy,
      },
      tool_calls: {
        total: snapshot.totalToolCalls,
        errors: snapshot.errorToolCalls,
        avg_latency_ms: snapshot.avgLatencyMs,
      },
      circuit_breakers: getAllCircuitStates(),
    });
  });
}
