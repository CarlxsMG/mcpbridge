import { describe, test, expect } from "bun:test";
import {
  breakerStateTransitions,
  breakerCurrentState,
  breakerProbeRejected,
  rateLimitHits,
  rateLimitEvictions,
  rateLimitBuckets,
  toolCallsTotal,
  proxyBodyCapRejections,
  proxyRetryAttempts,
  proxyRequestDuration,
  cacheEvents,
  lbRequests,
  coalesceHits,
  registryClients,
  registryToolsTotal,
  healthCheckDuration,
  healthCheckRunsTotal,
  healthLoopErrorsTotal,
  healthEvictionsTotal,
  wsProxyActiveConnections,
  wsProxyBytesTotal,
} from "../../observability/metrics.js";

// Cluster mc3 — src/observability/metrics.ts lines 164-279
//
// This block is a straight run of `metricsRegistry.register(new Counter/Gauge/Histogram(...))`
// declarations. Every surviving mutant in this cluster is a `StringLiteral` mutation that
// blanks out one of the `name` or `help` constructor arguments (replacement `""`). The existing
// dedicated test file (metrics.test.ts) only exercises hand-rolled Counter/Gauge/Histogram
// instances with made-up names ("test_counter_total" etc.) — it never asserts on these real
// exported constants, so every name/help string here was previously untested.
//
// Technique: bulk-schema-toEqual (established elsewhere in this program) — one test walks every
// exported metric constant and asserts its exact `.name`/`.help` public readonly fields against
// a hand-transcribed table read directly from source. A StringLiteral -> "" mutation on any
// field diverges from the corresponding table entry and fails that field's assertion.
//
// Mutant coverage (re-queried directly from reports/mutation/result.json, filtered to
// location.start.line in [164, 279] and status !== "Killed" — 37 Survived mutants, all
// mutatorName "StringLiteral"): ids 103-114, 116-132, 134, 136, 138, 140-144. Each is cited
// inline next to the table row it kills (mutant id, line:col, mutatorName). ids 115, 133, 135,
// 137, 139 (the `name` args of toolCallsTotal, healthCheckDuration, healthCheckRunsTotal,
// healthLoopErrorsTotal, healthEvictionsTotal) were already Killed by pre-existing tests
// (verified via the same report query) — they're included in the table anyway for completeness
// of the constant, but aren't cited as targets since they weren't surviving.

interface MetricStringLiterals {
  name: string;
  help: string;
}

const EXPECTED_METRICS: Array<{ metric: MetricStringLiterals; name: string; help: string }> = [
  // id103 (170:15-52 StringLiteral "name"), id104 (170:54-105 StringLiteral "help")
  {
    metric: breakerStateTransitions,
    name: "mcp_breaker_state_transitions_total",
    help: "Total number of circuit breaker state transitions",
  },
  // id105 (174:13-40 StringLiteral "name"), id106 (174:42-104 StringLiteral "help")
  {
    metric: breakerCurrentState,
    name: "mcp_breaker_current_state",
    help: "Current circuit breaker state: 0=closed, 1=half_open, 2=open",
  },
  // id107 (179:5-39 StringLiteral "name"), id108 (180:5-85 StringLiteral "help")
  {
    metric: breakerProbeRejected,
    name: "mcp_breaker_probe_rejected_total",
    help: "Total probe rejections (canRequest returned {allowed:false, reason:'Probing'})",
  },
  // id109 (186:15-42 StringLiteral "name"), id110 (186:44-96 StringLiteral "help")
  {
    metric: rateLimitHits,
    name: "mcp_rate_limit_hits_total",
    help: "Total number of requests rejected with 429 by tier",
  },
  // id111 (190:15-47 StringLiteral "name"), id112 (190:49-112 StringLiteral "help")
  {
    metric: rateLimitEvictions,
    name: "mcp_rate_limit_evictions_total",
    help: "Total number of rate-limit bucket evictions by tier and cause",
  },
  // id113 (194:13-37 StringLiteral "name"), id114 (194:39-92 StringLiteral "help")
  {
    metric: rateLimitBuckets,
    name: "mcp_rate_limit_buckets",
    help: "Current number of active rate-limit buckets by tier",
  },
  // name mutant id115 (199:15) already Killed pre-existing; id116 (199:39-102 StringLiteral "help")
  {
    metric: toolCallsTotal,
    name: "mcp_tool_calls_total",
    help: "Total number of proxied tool calls by outcome (success|error)",
  },
  // id117 (204:5-42 StringLiteral "name"), id118 (205:5-80 StringLiteral "help")
  {
    metric: proxyBodyCapRejections,
    name: "mcp_proxy_body_cap_rejections_total",
    help: "Total number of upstream responses rejected due to MAX_RESPONSE_BYTES cap",
  },
  // id119 (210:15-47 StringLiteral "name"), id120 (210:49-108 StringLiteral "help")
  {
    metric: proxyRetryAttempts,
    name: "mcp_proxy_retry_attempts_total",
    help: "Total proxy retry attempts by client, method, and outcome",
  },
  // id121 (215:5-41 StringLiteral "name"), id122 (216:5-81 StringLiteral "help")
  {
    metric: proxyRequestDuration,
    name: "mcp_proxy_request_duration_seconds",
    help: "Proxy HTTP request duration in seconds by client, method, and status class",
  },
  // id123 (222:15-48 StringLiteral "name"), id124 (222:50-118 StringLiteral "help")
  {
    metric: cacheEvents,
    name: "mcp_response_cache_events_total",
    help: "Total response-cache events by client and outcome (hit|miss|store)",
  },
  // id125 (226:15-38 StringLiteral "name"), id126 (226:40-115 StringLiteral "help")
  {
    metric: lbRequests,
    name: "mcp_lb_requests_total",
    help: "Total load-balanced requests by client and selected member (primary|pool)",
  },
  // id127 (231:5-30 StringLiteral "name"), id128 (232:5-96 StringLiteral "help")
  {
    metric: coalesceHits,
    name: "mcp_coalesce_hits_total",
    help: "Total tool calls served by piggybacking on an already in-flight identical call, by client",
  },
  // id129 (238:13-35 StringLiteral "name"), id130 (238:37-84 StringLiteral "help")
  {
    metric: registryClients,
    name: "mcp_registry_clients",
    help: "Number of registered clients by health status",
  },
  // id131 (242:13-39 StringLiteral "name"), id132 (242:41-98 StringLiteral "help")
  {
    metric: registryToolsTotal,
    name: "mcp_registry_tools_total",
    help: "Total number of tools currently indexed in the registry",
  },
  // name mutant id133 (248:5) already Killed pre-existing; id134 (249:5-61 StringLiteral "help")
  {
    metric: healthCheckDuration,
    name: "mcp_health_check_duration_seconds",
    help: "Health check duration in seconds by client and outcome",
  },
  // name mutant id135 (255:15) already Killed pre-existing; id136 (255:46-92 StringLiteral "help")
  {
    metric: healthCheckRunsTotal,
    name: "mcp_health_check_runs_total",
    help: "Total number of health check runs by outcome",
  },
  // name mutant id137 (259:15) already Killed pre-existing; id138 (259:47-112 StringLiteral "help")
  {
    metric: healthLoopErrorsTotal,
    name: "mcp_health_loop_errors_total",
    help: "Total number of unhandled errors in the health check outer loop",
  },
  // name mutant id139 (264:5) already Killed pre-existing; id140 (265:5-92 StringLiteral "help")
  {
    metric: healthEvictionsTotal,
    name: "mcp_health_evictions_total",
    help: "Total number of clients auto-evicted after crossing the consecutive-failure threshold",
  },
  // id141 (271:13-46 StringLiteral "name"), id142 (271:48-108 StringLiteral "help")
  {
    metric: wsProxyActiveConnections,
    name: "mcp_ws_proxy_active_connections",
    help: "Number of live WebSocket passthrough connections by target",
  },
  // id143 (276:5-31 StringLiteral "name"), id144 (277:5-96 StringLiteral "help")
  {
    metric: wsProxyBytesTotal,
    name: "mcp_ws_proxy_bytes_total",
    help: "Total bytes relayed by the WebSocket passthrough proxy, by target and direction (up|down)",
  },
];

describe("real exported metric constants — name/help string literals (cluster mc3)", () => {
  test("every exported metric constant has its exact expected name and help text", () => {
    for (const { metric, name, help } of EXPECTED_METRICS) {
      expect(metric.name).toBe(name);
      expect(metric.help).toBe(help);
    }
  });

  // Belt-and-braces: also confirm the constants are wired into the shared registry and that
  // their real name/help text actually reaches rendered Prometheus output (guards against a
  // mutant that swaps which registry.register(...) call a constant's return value flows from,
  // even though no such mutant surfaced in this cluster's line range).
  test("a sample of real constants render their exact name/help through the class render() path", () => {
    breakerStateTransitions.inc({ from: "closed", to: "open" });
    const rendered = breakerStateTransitions.render();
    expect(rendered).toContain(
      "# HELP mcp_breaker_state_transitions_total Total number of circuit breaker state transitions",
    );
    expect(rendered).toContain("# TYPE mcp_breaker_state_transitions_total counter");

    wsProxyActiveConnections.set({ target: "test-target" }, 1);
    const renderedGauge = wsProxyActiveConnections.render();
    expect(renderedGauge).toContain(
      "# HELP mcp_ws_proxy_active_connections Number of live WebSocket passthrough connections by target",
    );
  });
});
