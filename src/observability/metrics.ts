/**
 * Minimal Prometheus exposition format (text/plain; version=0.0.4) implementation.
 * No external dependencies. Supports Counter, Gauge, and Histogram.
 */

// ── Label helpers ─────────────────────────────────────────────────────────────

function formatLabels(labels: Record<string, string>): string {
  const entries = Object.entries(labels);
  if (entries.length === 0) return "";
  const parts = entries.map(([k, v]) => `${k}="${escapeLabel(v)}"`);
  return `{${parts.join(",")}}`;
}

function escapeLabel(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

function seriesKey(labels: Record<string, string>): string {
  return JSON.stringify(labels, Object.keys(labels).sort());
}

// ── Counter ───────────────────────────────────────────────────────────────────

/** Monotonically increasing counter. */
export class Counter {
  readonly name: string;
  readonly help: string;
  private data = new Map<string, number>();

  constructor(name: string, help: string) {
    this.name = name;
    this.help = help;
  }

  /** Increment by value (default 1). */
  inc(labels: Record<string, string> = {}, value = 1): void {
    const key = seriesKey(labels);
    this.data.set(key, (this.data.get(key) ?? 0) + value);
  }

  /** @internal */
  render(): string {
    const lines: string[] = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`];
    for (const [key, val] of this.data) {
      const labels = JSON.parse(key) as Record<string, string>;
      lines.push(`${this.name}${formatLabels(labels)} ${val}`);
    }
    return lines.join("\n");
  }
}

// ── Gauge ─────────────────────────────────────────────────────────────────────

/** Gauge that can go up and down. */
export class Gauge {
  readonly name: string;
  readonly help: string;
  private data = new Map<string, number>();

  constructor(name: string, help: string) {
    this.name = name;
    this.help = help;
  }

  /** Set the gauge value. */
  set(labels: Record<string, string> = {}, value: number): void {
    this.data.set(seriesKey(labels), value);
  }

  /** @internal */
  render(): string {
    const lines: string[] = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} gauge`];
    for (const [key, val] of this.data) {
      const labels = JSON.parse(key) as Record<string, string>;
      lines.push(`${this.name}${formatLabels(labels)} ${val}`);
    }
    return lines.join("\n");
  }
}

// ── Histogram ─────────────────────────────────────────────────────────────────

/** Fixed-bucket histogram. */
export class Histogram {
  readonly name: string;
  readonly help: string;
  readonly buckets: readonly number[];

  private counts = new Map<string, number[]>();
  private sums = new Map<string, number>();
  private totals = new Map<string, number>();

  constructor(name: string, help: string, buckets: readonly number[]) {
    this.name = name;
    this.help = help;
    this.buckets = [...buckets].sort((a, b) => a - b);
  }

  /** Record an observation. */
  observe(labels: Record<string, string> = {}, value: number): void {
    const key = seriesKey(labels);
    if (!this.counts.has(key)) {
      this.counts.set(key, new Array<number>(this.buckets.length).fill(0));
      this.sums.set(key, 0);
      this.totals.set(key, 0);
    }
    const bkts = this.counts.get(key)!;
    for (let i = 0; i < this.buckets.length; i++) {
      if (value <= this.buckets[i]) bkts[i]++;
    }
    this.sums.set(key, (this.sums.get(key) ?? 0) + value);
    this.totals.set(key, (this.totals.get(key) ?? 0) + 1);
  }

  /** @internal */
  render(): string {
    const lines: string[] = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
    for (const [key, bkts] of this.counts) {
      const labels = JSON.parse(key) as Record<string, string>;
      const baseLabels = formatLabels(labels);
      const labelStr =
        Object.keys(labels).length > 0
          ? `{${Object.entries(labels)
              .map(([k, v]) => `${k}="${escapeLabel(v)}"`)
              .join(",")},le="{{LE}}"}`
          : `{le="{{LE}}"}`;

      for (let i = 0; i < this.buckets.length; i++) {
        lines.push(`${this.name}_bucket${labelStr.replace("{{LE}}", String(this.buckets[i]))} ${bkts[i]}`);
      }
      const infLabel =
        Object.keys(labels).length > 0
          ? `{${Object.entries(labels)
              .map(([k, v]) => `${k}="${escapeLabel(v)}"`)
              .join(",")},le="+Inf"}`
          : `{le="+Inf"}`;
      lines.push(`${this.name}_bucket${infLabel} ${this.totals.get(key) ?? 0}`);
      lines.push(`${this.name}_sum${baseLabels} ${this.sums.get(key) ?? 0}`);
      lines.push(`${this.name}_count${baseLabels} ${this.totals.get(key) ?? 0}`);
    }
    return lines.join("\n");
  }
}

// ── Registry ──────────────────────────────────────────────────────────────────

export class MetricsRegistry {
  private metrics: Array<Counter | Gauge | Histogram> = [];

  register<T extends Counter | Gauge | Histogram>(metric: T): T {
    this.metrics.push(metric);
    return metric;
  }

  /** Produces Prometheus text exposition format. */
  render(): string {
    return this.metrics.map((m) => m.render()).join("\n\n") + "\n";
  }
}

export const metricsRegistry = new MetricsRegistry();

// ── Metric constants ──────────────────────────────────────────────────────────

const DURATION_BUCKETS = [0.005, 0.01, 0.05, 0.1, 0.5, 1, 2, 5, 10, 30] as const;

// Circuit breaker
export const breakerStateTransitions = metricsRegistry.register(
  new Counter("mcp_breaker_state_transitions_total", "Total number of circuit breaker state transitions"),
);

export const breakerCurrentState = metricsRegistry.register(
  new Gauge("mcp_breaker_current_state", "Current circuit breaker state: 0=closed, 1=half_open, 2=open"),
);

export const breakerProbeRejected = metricsRegistry.register(
  new Counter(
    "mcp_breaker_probe_rejected_total",
    "Total probe rejections (canRequest returned {allowed:false, reason:'Probing'})",
  ),
);

// Rate limiter
export const rateLimitHits = metricsRegistry.register(
  new Counter("mcp_rate_limit_hits_total", "Total number of requests rejected with 429 by tier"),
);

export const rateLimitEvictions = metricsRegistry.register(
  new Counter("mcp_rate_limit_evictions_total", "Total number of rate-limit bucket evictions by tier and cause"),
);

export const rateLimitBuckets = metricsRegistry.register(
  new Gauge("mcp_rate_limit_buckets", "Current number of active rate-limit buckets by tier"),
);

// Proxy
export const toolCallsTotal = metricsRegistry.register(
  new Counter("mcp_tool_calls_total", "Total number of proxied tool calls by outcome (success|error)"),
);

export const proxyBodyCapRejections = metricsRegistry.register(
  new Counter(
    "mcp_proxy_body_cap_rejections_total",
    "Total number of upstream responses rejected due to MAX_RESPONSE_BYTES cap",
  ),
);

export const proxyRetryAttempts = metricsRegistry.register(
  new Counter("mcp_proxy_retry_attempts_total", "Total proxy retry attempts by client, method, and outcome"),
);

export const proxyRequestDuration = metricsRegistry.register(
  new Histogram(
    "mcp_proxy_request_duration_seconds",
    "Proxy HTTP request duration in seconds by client, method, and status class",
    DURATION_BUCKETS,
  ),
);

export const cacheEvents = metricsRegistry.register(
  new Counter("mcp_response_cache_events_total", "Total response-cache events by client and outcome (hit|miss|store)"),
);

export const lbRequests = metricsRegistry.register(
  new Counter("mcp_lb_requests_total", "Total load-balanced requests by client and selected member (primary|pool)"),
);

export const coalesceHits = metricsRegistry.register(
  new Counter(
    "mcp_coalesce_hits_total",
    "Total tool calls served by piggybacking on an already in-flight identical call, by client",
  ),
);

// Registry
export const registryClients = metricsRegistry.register(
  new Gauge("mcp_registry_clients", "Number of registered clients by health status"),
);

export const registryToolsTotal = metricsRegistry.register(
  new Gauge("mcp_registry_tools_total", "Total number of tools currently indexed in the registry"),
);

// Health checks
export const healthCheckDuration = metricsRegistry.register(
  new Histogram(
    "mcp_health_check_duration_seconds",
    "Health check duration in seconds by client and outcome",
    DURATION_BUCKETS,
  ),
);

export const healthCheckRunsTotal = metricsRegistry.register(
  new Counter("mcp_health_check_runs_total", "Total number of health check runs by outcome"),
);

export const healthLoopErrorsTotal = metricsRegistry.register(
  new Counter("mcp_health_loop_errors_total", "Total number of unhandled errors in the health check outer loop"),
);

export const healthEvictionsTotal = metricsRegistry.register(
  new Counter(
    "mcp_health_evictions_total",
    "Total number of clients auto-evicted after crossing the consecutive-failure threshold",
  ),
);

// WS proxy
export const wsProxyActiveConnections = metricsRegistry.register(
  new Gauge("mcp_ws_proxy_active_connections", "Number of live WebSocket passthrough connections by target"),
);

export const wsProxyBytesTotal = metricsRegistry.register(
  new Counter(
    "mcp_ws_proxy_bytes_total",
    "Total bytes relayed by the WebSocket passthrough proxy, by target and direction (up|down)",
  ),
);

// ── Legacy JSON metrics state (kept for backwards compatibility) ─────────────

let totalToolCalls = 0;
let errorToolCalls = 0;
const latencies: number[] = [];
const MAX_LATENCY_WINDOW = 100;
const startedAt = Date.now();

/** Records a completed tool call for the legacy JSON metrics endpoint and the Prometheus counter. */
export function recordToolCall(durationMs: number, isError: boolean): void {
  totalToolCalls++;
  if (isError) errorToolCalls++;
  latencies.push(durationMs);
  if (latencies.length > MAX_LATENCY_WINDOW) latencies.shift();
  toolCallsTotal.inc({ outcome: isError ? "error" : "success" });
}

// Session count getter — will be set externally
let getSessionCounts: () => { streamable: number } = () => ({ streamable: 0 });

/** Registers the callback used to report current live-session counts. */
export function setSessionCountGetter(fn: () => { streamable: number }): void {
  getSessionCounts = fn;
}

/** Snapshot of the legacy JSON metrics state, for consumption by the /metrics/legacy route. */
export function getLegacyMetricsSnapshot(): {
  uptimeSeconds: number;
  sessions: { streamable: number };
  totalToolCalls: number;
  errorToolCalls: number;
  avgLatencyMs: number;
} {
  const avgLatencyMs = latencies.length > 0 ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : 0;
  return {
    uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
    sessions: getSessionCounts(),
    totalToolCalls,
    errorToolCalls,
    avgLatencyMs,
  };
}
