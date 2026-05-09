import type { Request, Response, Express } from "express";
import { registry } from "../registry.js";
import { getAllCircuitStates, getAllBreakerStateGauges } from "../circuit-breaker.js";
import { adminAuth } from "../middleware/auth.js";
import { config } from "../config.js";
import { getRateLimitBucketSizes } from "../middleware/rate-limiter.js";
import {
  metricsRegistry,
  breakerCurrentState,
  registryClients,
  registryToolsTotal,
  rateLimitBuckets,
} from "../observability/metrics.js";

// ── Legacy JSON metrics (kept for backwards compatibility) ───────────────────

let totalToolCalls = 0;
let errorToolCalls = 0;
const latencies: number[] = [];
const MAX_LATENCY_WINDOW = 100;
const startedAt = Date.now();

export function recordToolCall(durationMs: number, isError: boolean): void {
  totalToolCalls++;
  if (isError) errorToolCalls++;
  latencies.push(durationMs);
  if (latencies.length > MAX_LATENCY_WINDOW) latencies.shift();
}

// Session count getter — will be set externally
let getSessionCounts: () => { streamable: number; sse: number } = () => ({ streamable: 0, sse: 0 });

export function setSessionCountGetter(fn: () => { streamable: number; sse: number }): void {
  getSessionCounts = fn;
}

// ── Prometheus snapshot helpers ───────────────────────────────────────────────

function snapshotGauges(): void {
  // Circuit breaker current states
  for (const { client, value } of getAllBreakerStateGauges()) {
    breakerCurrentState.set({ client }, value);
  }

  // Registry client counts by status
  const clients = registry.listClients();
  const healthy = clients.filter(c => c.status === "healthy").length;
  const degraded = clients.filter(c => c.status === "degraded").length;
  const unreachable = clients.filter(c => c.status === "unreachable").length;
  registryClients.set({ status: "healthy" }, healthy);
  registryClients.set({ status: "degraded" }, degraded);
  registryClients.set({ status: "unreachable" }, unreachable);

  // Registry tool index size — read from introspect accessor
  registryToolsTotal.set({}, clients.reduce((sum, c) => sum + (c.tools?.length ?? 0), 0));

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
      res.status(404).json({ error: { code: "NOT_FOUND", message: "Metrics endpoint is disabled" } });
      return;
    }

    snapshotGauges();

    res.setHeader("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
    res.status(200).send(metricsRegistry.render());
  });

  // Legacy JSON endpoint kept for backwards compat (internal use / health dashboards)
  app.get("/metrics/legacy", adminAuth, (_req: Request, res: Response) => {
    const clients = registry.listClients();
    const healthy = clients.filter(c => c.status === "healthy").length;
    const sessions = getSessionCounts();
    const avgLatency = latencies.length > 0
      ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
      : 0;

    res.json({
      uptime_seconds: Math.floor((Date.now() - startedAt) / 1000),
      active_sessions: sessions,
      registered_clients: {
        total: clients.length,
        healthy,
        unreachable: clients.length - healthy,
      },
      tool_calls: {
        total: totalToolCalls,
        errors: errorToolCalls,
        avg_latency_ms: avgLatency,
      },
      circuit_breakers: getAllCircuitStates(),
    });
  });
}
