import type { Request, Response, Express } from "express";
import { registry } from "../registry.js";
import { getAllCircuitStates } from "../circuit-breaker.js";
import { adminAuth } from "../middleware/auth.js";

// Counters
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

export function metricsRoutes(app: Express): void {
  app.get("/metrics", adminAuth, (_req: Request, res: Response) => {
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
