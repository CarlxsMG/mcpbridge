/**
 * Stryker mutation backstop — health.ts cluster hc2 (lines 33-55): the
 * REST-kind client branch of checkBatch() — pinned-IP URL construction
 * (new URL(client.health_url) + hostname swap to client.resolved_ip + Host
 * header preservation) and the fetch call with a timeout signal — plus the
 * success-path handling immediately after: healthCheckDuration/
 * healthCheckRunsTotal metrics, registry.resetConsecutiveFailures,
 * registry.markClientStatus("healthy"), and the
 * `previousStatus !== "healthy"` edge-trigger for notifyToolsChanged().
 *
 * checkBatch/handleFailure are module-private — every test below drives this
 * logic indirectly through the sole exported entry point, startHealthCheckLoop(),
 * per the project convention: register client(s), start the loop, await a
 * short delay for its immediately-invoked check tick, then stop() in a
 * try/finally so no interval leaks into a later test file (bun:test runs
 * every file in one process).
 *
 * Ground truth re-queried directly from reports/mutation/result.json,
 * filtered to mutants whose location.start.line falls in [33, 55] and whose
 * status is NOT "Killed" (verified independently of this prompt's prose —
 * see house convention after a prior session's orchestrator mis-citation):
 *
 *   id 20 — BlockStatement   L33:18-L46:12   → {}      (whole REST-branch body emptied)
 *   id 21 — ObjectLiteral    L40:54-L44:14   → {}      (fetch() options object emptied)
 *   id 22 — ObjectLiteral    L41:24-L41:52   → {}      (fetch headers object emptied)
 *   id 24 — ConditionalExpr  L47:15-L47:17   → false   (`if (ok)` forced false)
 *   id 27 — StringLiteral    L48:73-L48:82   → ""      ("success" outcome label, duration.observe)
 *   id 25 — BlockStatement   L47:19-L55:12   → {}      (whole `if (ok) {...}` success body emptied)
 *   id 26 — ObjectLiteral    L48:41-L48:84   → {}      (duration.observe labels object emptied)
 *   id 28 — ArithmeticOperator L48:86-L48:115 → (Date.now() - hcStart) * 1000  (÷1000 → ×1000)
 *   id 29 — ArithmeticOperator L48:87-L48:107 → Date.now() + hcStart          (subtraction → addition)
 *   id 30 — ObjectLiteral    L49:38-L49:60   → {}      (runsTotal.inc labels object emptied)
 *   id 31 — StringLiteral    L49:49-L49:58   → ""      ("success" outcome label, runsTotal.inc)
 *   id 32 — StringLiteral    L51:52-L51:61   → ""      ("healthy" status string, markClientStatus)
 *   id 34 — ConditionalExpr  L52:17-L52:45   → false   (`if (previousStatus !== "healthy")` forced false)
 *   id 33 — ConditionalExpr  L52:17-L52:45   → true    (forced true)
 *   id 35 — EqualityOperator L52:17-L52:45   → previousStatus === "healthy"
 *   id 36 — StringLiteral    L52:36-L52:45   → ""      ("healthy" comparison string)
 *   id 37 — BlockStatement   L52:47-L54:14   → {}      (notifyToolsChanged() call body emptied)
 *
 * (id 23 and id 38, also in this line range, were already Killed at baseline
 * and are out of scope for this cluster.)
 *
 * Run: bun run test (never bare `bun test` — see CLAUDE.md).
 */
import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { registry } from "../../mcp/registry.js";
import * as mcpServerMod from "../../mcp/mcp-server.js";
import { __resetDbForTesting } from "../../db/connection.js";
import { refreshLeaderStatus } from "../../db/leader-lease.js";
import { healthCheckDuration, healthCheckRunsTotal } from "../../observability/metrics.js";
import { startHealthCheckLoop } from "../../observability/health.js";
import type { RestToolDefinition } from "../../mcp/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTool(): RestToolDefinition {
  return {
    name: "get-users",
    method: "GET",
    endpoint: "/users",
    description: "Returns a list of users",
    inputSchema: { type: "object", properties: {} },
  };
}

/** Registers a REST client with a distinct health_url host and pinned resolved_ip so the
 *  URL-rewrite (host -> resolved_ip, original host preserved as the Host header) is observable. */
async function registerClient(name: string): Promise<void> {
  await registry.register(
    name,
    [makeTool()],
    "http://health.example.com/health",
    "127.0.0.1",
    "http://health.example.com",
    "10.0.0.9",
  );
}

interface CapturedFetchCall {
  url: string;
  init: RequestInit;
}

let fetchCalls: CapturedFetchCall[] = [];

/** Installs a fetch mock that records every call's (url, init) and always resolves ok (200). */
function mockFetchSuccess(): void {
  fetchCalls = [];
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    fetchCalls.push({ url: String(url), init: (init ?? {}) as RequestInit });
    return new Response(null, { status: 200 });
  }) as unknown as typeof fetch;
}

/**
 * Same as mockFetchSuccess, but resolves after a real (short) delay instead of
 * instantly. A near-instant mock makes `Date.now() - hcStart` genuinely equal
 * `0` within the same millisecond tick, at which point `0 / 1000` and
 * `0 * 1000` are BOTH `0` — mathematically indistinguishable regardless of
 * the operator (empirically confirmed by hand-applying the real `/1000 ->
 * *1000` mutation and re-running the plain mockFetchSuccess-based test: it
 * still passed unmodified). A real, non-zero elapsed gap is required to
 * actually discriminate the two operators.
 */
function mockFetchSuccessDelayed(delayMs: number): void {
  fetchCalls = [];
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    fetchCalls.push({ url: String(url), init: (init ?? {}) as RequestInit });
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    return new Response(null, { status: 200 });
  }) as unknown as typeof fetch;
}

/** Reads a Counter's current value for one exact label string (e.g. `outcome="success"`). */
function parseCounterValue(rendered: string, metricName: string, labelStr: string): number {
  const re = new RegExp(`${metricName}\\{${labelStr}\\}\\s+(\\d+(?:\\.\\d+)?)`);
  const m = rendered.match(re);
  return m ? Number(m[1]) : 0;
}

/** Reads a Histogram's _sum/_count for an exact (client, outcome) label pair, or undefined if absent. */
function parseHistogramSumCount(
  rendered: string,
  metricName: string,
  client: string,
  outcome: string,
): { sum: number; count: number } | undefined {
  const sumRe = new RegExp(`${metricName}_sum\\{client="${client}",outcome="${outcome}"\\}\\s+([0-9.eE+-]+)`);
  const countRe = new RegExp(`${metricName}_count\\{client="${client}",outcome="${outcome}"\\}\\s+([0-9.eE+-]+)`);
  const sumMatch = rendered.match(sumRe);
  const countMatch = rendered.match(countRe);
  if (!sumMatch || !countMatch) return undefined;
  return { sum: Number(sumMatch[1]), count: Number(countMatch[1]) };
}

const originalFetch = globalThis.fetch;

beforeEach(async () => {
  for (const c of registry.listClients()) {
    await registry.unregister(c.name);
  }
  __resetDbForTesting();
  refreshLeaderStatus(); // health.ts's loop only probes backends when isLeader() is true
  globalThis.fetch = originalFetch;
});

afterEach(async () => {
  for (const c of registry.listClients()) {
    await registry.unregister(c.name);
  }
  __resetDbForTesting();
  globalThis.fetch = originalFetch;
});

// ---------------------------------------------------------------------------
// hc2-a: pinned-IP URL construction + Host header + fetch options
// kills: id 20 (BlockStatement), id 21 (ObjectLiteral, fetch options), id 22 (ObjectLiteral, headers)
// ---------------------------------------------------------------------------

describe("hc2 — REST branch fetches the pinned-IP URL with the correct options", () => {
  test("fetch is called with resolved_ip host, preserved Host header, redirect:error, and a timeout signal", async () => {
    const clientName = "hc2-pin-svc";
    await registerClient(clientName);
    mockFetchSuccess();

    const stop = startHealthCheckLoop();
    try {
      await new Promise((resolve) => setTimeout(resolve, 80));
    } finally {
      stop();
    }

    // If the whole else-branch body were emptied (id 20), fetch would never be called at all.
    expect(fetchCalls.length).toBeGreaterThan(0);

    const call = fetchCalls[0];
    const calledUrl = new URL(call.url);
    // hostname must be swapped to the pinned resolved_ip (DNS-rebinding protection)
    expect(calledUrl.hostname).toBe("10.0.0.9");
    expect(calledUrl.pathname).toBe("/health");

    // If the fetch options object were emptied (id 21), `init.headers` would be undefined here.
    const headers = call.init.headers as Record<string, string>;
    expect(headers.Host).toBe("health.example.com");

    expect(call.init.redirect).toBe("error");
    expect(call.init.signal).toBeInstanceOf(AbortSignal);
  });
});

// ---------------------------------------------------------------------------
// hc2-b: success-path metrics, failure-count reset, and status update
// kills: id 24, 25, 26, 27, 28, 29, 30, 31, 32
// ---------------------------------------------------------------------------

describe("hc2 — a successful health check records success metrics and resets failure state", () => {
  test("success records duration+counter with outcome=success, resets consecutive_failures, and marks healthy", async () => {
    const clientName = "hc2-success-svc";
    await registerClient(clientName);

    // Give the client some prior failures + a non-healthy status, so the reset/markClientStatus
    // effects of a subsequent success are actually observable (a fresh client already reads
    // consecutive_failures: 0 / status: "healthy", which would make those assertions vacuous).
    registry.incrementConsecutiveFailures(clientName);
    registry.incrementConsecutiveFailures(clientName);
    registry.markClientStatus(clientName, "unreachable");

    const runsBefore = parseCounterValue(
      healthCheckRunsTotal.render(),
      "mcp_health_check_runs_total",
      'outcome="success"',
    );

    // A real (short) delay is required, not an instantly-resolving mock: with zero elapsed
    // time, `Date.now() - hcStart` is exactly 0, and 0/1000 === 0*1000 === 0 — the ÷1000 -> ×1000
    // mutant (id 28) is otherwise silently unobservable (confirmed by hand-applying it against
    // the instant mock and seeing every assertion below still pass unmodified).
    mockFetchSuccessDelayed(20);
    const stop = startHealthCheckLoop();
    try {
      await new Promise((resolve) => setTimeout(resolve, 200));
    } finally {
      stop();
    }

    // id 24 (`if (ok)` forced false) and id 25 (whole success block emptied) would both leave this
    // unchanged (or drive the failure branch instead).
    const runsAfter = parseCounterValue(
      healthCheckRunsTotal.render(),
      "mcp_health_check_runs_total",
      'outcome="success"',
    );
    expect(runsAfter).toBeGreaterThan(runsBefore);

    // id 26 (labels object emptied) and id 27 (outcome string emptied) both make this lookup miss
    // (the recorded series would be unlabeled, or labeled outcome="" instead of "success").
    const hist = parseHistogramSumCount(
      healthCheckDuration.render(),
      "mcp_health_check_duration_seconds",
      clientName,
      "success",
    );
    expect(hist).toBeDefined();
    expect(hist!.count).toBe(1);
    // Real duration is (elapsed ms)/1000 seconds: with a real ~20ms delay, comfortably inside
    // (0.01, 5) seconds. id 28 (÷1000 -> ×1000) would produce ~20000 (0.02*1000*1000), and id 29
    // (subtraction -> addition, i.e. two summed Unix timestamps ~1.7e12 each) would produce ~3.4e12
    // — both blow this tight bound.
    expect(hist!.sum).toBeGreaterThan(0.01);
    expect(hist!.sum).toBeLessThan(5);

    // id 30 (labels object emptied) / id 31 (outcome string emptied) already covered above via
    // runsAfter; id 32 (the "healthy" string literal emptied) is covered by this exact-match:
    const client = registry.getClient(clientName);
    expect(client?.status).toBe("healthy");
    expect(client?.consecutive_failures).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// hc2-c: notifyToolsChanged only fires on an actual healthy-transition edge
// kills: id 33, 34, 35, 36, 37 (jointly, via the two complementary sub-tests below)
// ---------------------------------------------------------------------------

describe("hc2 — notifyToolsChanged fires only when a success flips status away from non-healthy", () => {
  test("previousStatus=unreachable + success -> notifyToolsChanged fires", async () => {
    const clientName = "hc2-notify-flip-svc";
    await registerClient(clientName);
    registry.markClientStatus(clientName, "unreachable");

    const spy = spyOn(mcpServerMod, "notifyToolsChanged");
    try {
      spy.mockClear();
      mockFetchSuccess();
      const stop = startHealthCheckLoop();
      try {
        await new Promise((resolve) => setTimeout(resolve, 80));
      } finally {
        stop();
      }

      // id 34 (condition forced false) and id 37 (notifyToolsChanged() call body emptied) both
      // suppress this call; id 35 (!== -> ===) also evaluates false for previousStatus="unreachable".
      expect(spy).toHaveBeenCalled();
      expect(registry.getClient(clientName)?.status).toBe("healthy");
    } finally {
      spy.mockRestore();
    }
  });

  test("previousStatus=healthy (steady-state) + success -> notifyToolsChanged does NOT fire", async () => {
    const clientName = "hc2-notify-steady-svc";
    await registerClient(clientName); // register() defaults a new client to status "healthy"
    expect(registry.getClient(clientName)?.status).toBe("healthy");

    const spy = spyOn(mcpServerMod, "notifyToolsChanged");
    try {
      spy.mockClear();
      mockFetchSuccess();
      const stop = startHealthCheckLoop();
      try {
        await new Promise((resolve) => setTimeout(resolve, 80));
      } finally {
        stop();
      }

      // id 33 (condition forced true) and id 36 ("healthy" string emptied, so the comparison
      // becomes previousStatus !== "" which is true for "healthy") both wrongly fire here.
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});
