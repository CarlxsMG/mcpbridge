/**
 * Stryker mutation backstop — cluster hc1
 *
 * Target: src/observability/health.ts lines 11-33 — checkBatch's batching
 * loop (the for-loop stepping by config.healthCheckMaxConcurrent, and
 * Promise.allSettled over each batch), and the MCP-kind client branch
 * (client.kind === "mcp", using mcpUpstream.ping with mcpUrl/base_url/
 * mcpTransport/resolvedIp/authHeaders fallbacks).
 *
 * checkBatch and handleFailure are module-private — the only exported entry
 * point is startHealthCheckLoop(), so every test drives the target logic
 * indirectly: register client(s), call startHealthCheckLoop(), await a short
 * delay for the immediately-invoked leader-gated tick to run, then stop().
 * Always inside try/finally so no interval leaks into a later test file
 * (bun:test runs every file in one process).
 *
 * ---------------------------------------------------------------------------
 * EQUIVALENT MUTANT — documented, not tested (mutant id 2)
 * ---------------------------------------------------------------------------
 * Location: health.ts:12:19-37, EqualityOperator, `i < clients.length` ->
 * `i <= clients.length` (the for-loop's stopping condition).
 *
 * This mutation only ever changes behavior at the exact moment `i` becomes
 * equal to `clients.length` (for any other value both operators agree, and
 * once `i` has stepped past `clients.length` both are false). At that one
 * boundary point, `clients.slice(i, i + concurrency)` is evaluated with
 * `i === clients.length`, which per the Array.prototype.slice spec always
 * returns `[]` (start >= length => empty result), regardless of `clients`'
 * contents or `concurrency`. `Promise.allSettled([].map(...))` on an empty
 * array resolves immediately with no iterations of the callback — no fetch
 * call, no mcpUpstream.ping call, no metric increment, no log call, nothing
 * that any test (black-box against the SUT's public behavior) can observe.
 * So the mutant either runs one extra fully-inert loop pass (when
 * `clients.length` is an exact multiple of `healthCheckMaxConcurrent`) or
 * doesn't run at all (otherwise) — the set of *real* (non-empty) batches
 * processed is byte-for-byte identical either way.
 *
 * Verified empirically with a standalone simulation
 * (scratch/eq-check.mjs, run via `node`) that reimplements just the loop
 * shape with both operators across seven (length, concurrency) pairs,
 * including exact multiples, exact-1, single-batch, and the empty-clients
 * case, and diffed the sequence of non-empty batch sizes each variant
 * produces — identical in every case:
 *
 *   len=4 conc=2  orig=[2,2]   mut=[2,2,0]   sameRealWork=true
 *   len=2 conc=1  orig=[1,1]   mut=[1,1,0]   sameRealWork=true
 *   len=1 conc=1  orig=[1]     mut=[1,0]     sameRealWork=true
 *   len=5 conc=5  orig=[5]     mut=[5,0]     sameRealWork=true
 *   len=6 conc=3  orig=[3,3]   mut=[3,3,0]   sameRealWork=true
 *   len=3 conc=3  orig=[3]     mut=[3,0]     sameRealWork=true
 *   len=0 conc=2  orig=[]      mut=[0]       sameRealWork=true
 *
 * A test could only "kill" this mutant by spying on a JS built-in
 * (Array.prototype.slice / Promise.allSettled call counts) to detect the
 * extra no-op pass — that isn't a behavioral difference of the SUT, so no
 * such test is written.
 */
import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { registry } from "../../mcp/registry.js";
import { config } from "../../config.js";
import { __resetDbForTesting } from "../../db/connection.js";
import { refreshLeaderStatus } from "../../db/leader-lease.js";
import { mcpUpstream } from "../../mcp/mcp-upstream.js";
import { setUpstreamAuth, clearUpstreamAuth } from "../../backend-auth/upstream-auth.js";
import type { RestToolDefinition } from "../../mcp/types.js";
import type { DiscoveredMcpTool } from "../../mcp/mcp-discovery.js";

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

async function registerRestClient(name: string, healthUrl = "http://example.com/health") {
  await registry.register(name, [makeTool()], healthUrl, "1.2.3.4", "http://example.com", "1.2.3.4");
}

const MCP_TOOLS: DiscoveredMcpTool[] = [
  { name: "echo", upstreamName: "echo", description: "Echoes", inputSchema: { type: "object", properties: {} } },
];

async function registerMcpClient(
  name: string,
  mcpUrl: string,
  transport: "streamable-http" | "sse",
  resolvedIp: string,
) {
  await registry.registerMcp(name, MCP_TOOLS, mcpUrl, transport, resolvedIp, resolvedIp);
}

const originalFetch = globalThis.fetch;
const originalSecretKey = config.secretEncryptionKey;

beforeEach(async () => {
  for (const c of registry.listClients()) {
    await registry.unregister(c.name);
  }
  __resetDbForTesting();
  refreshLeaderStatus(); // health.ts's loop only probes backends when isLeader() is true
  globalThis.fetch = originalFetch;
  // Needed for setUpstreamAuth()/getUpstreamAuthHeaders() in the ping-args test.
  (config as Record<string, unknown>).secretEncryptionKey = Buffer.alloc(32, 7).toString("base64");
});

afterEach(async () => {
  for (const c of registry.listClients()) {
    await registry.unregister(c.name);
  }
  __resetDbForTesting();
  globalThis.fetch = originalFetch;
  (config as Record<string, unknown>).healthCheckMaxConcurrent = 20;
  (config as Record<string, unknown>).secretEncryptionKey = originalSecretKey;
});

// ---------------------------------------------------------------------------
// Batching loop (lines 11-14)
// ---------------------------------------------------------------------------

describe("checkBatch — batching loop", () => {
  // Kills mutant id 6 (health.ts:13:19-72, MethodExpression:
  // `clients.slice(i, i + config.healthCheckMaxConcurrent)` -> `clients`).
  // With healthCheckMaxConcurrent=1 and 2 clients, the real loop makes 2
  // iterations of exactly 1 client each (2 fetch calls total). If `.slice`
  // is dropped so `batch` becomes the *entire* `clients` array every
  // iteration, both iterations process both clients => 4 fetch calls.
  test("each client's backend is probed exactly once, not once per loop iteration", async () => {
    (config as Record<string, unknown>).healthCheckMaxConcurrent = 1;

    await registerRestClient("batch-svc-a", "http://example.com/health-a");
    await registerRestClient("batch-svc-b", "http://example.com/health-b");

    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls++;
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;

    const { startHealthCheckLoop } = await import("../../observability/health.js");
    const stop = startHealthCheckLoop();
    try {
      await new Promise((resolve) => setTimeout(resolve, 80));
    } finally {
      stop();
    }

    expect(fetchCalls).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// MCP-kind branch condition (line 20)
// ---------------------------------------------------------------------------

describe('checkBatch — client.kind === "mcp" branch selection', () => {
  // Kills mutant ids 11 (ConditionalExpression -> `false`), 12
  // (EqualityOperator -> `client.kind !== "mcp"`), 13 (StringLiteral ->
  // `client.kind === ""`), and 14 (BlockStatement -> `{}`, the whole
  // if-body). Any of these mutations makes a genuine MCP-kind client skip
  // (or empty out) the mcpUpstream.ping call, which we can observe directly
  // via a spy.
  test("an MCP-kind client is probed via mcpUpstream.ping", async () => {
    await registerMcpClient("mcp-svc-ok", "http://mcp.test/mcp", "streamable-http", "10.0.0.1");

    const pingSpy = spyOn(mcpUpstream, "ping").mockImplementation(async () => true);

    try {
      const { startHealthCheckLoop } = await import("../../observability/health.js");
      const stop = startHealthCheckLoop();
      try {
        await new Promise((resolve) => setTimeout(resolve, 80));
      } finally {
        stop();
      }

      expect(pingSpy).toHaveBeenCalled();
      expect(registry.getClient("mcp-svc-ok")?.status).toBe("healthy");
    } finally {
      pingSpy.mockRestore();
    }
  });

  // Kills mutant id 10 (ConditionalExpression -> `true`), which would force
  // even a REST-kind client down the MCP branch (calling mcpUpstream.ping
  // instead of fetch). Also exercises the correct-negative direction for
  // mutant 12's EqualityOperator flip on a REST client.
  test("a REST-kind client is never probed via mcpUpstream.ping", async () => {
    await registerRestClient("rest-svc-ok");

    globalThis.fetch = (async () => new Response("ok", { status: 200 })) as unknown as typeof fetch;
    const pingSpy = spyOn(mcpUpstream, "ping").mockImplementation(async () => true);

    try {
      const { startHealthCheckLoop } = await import("../../observability/health.js");
      const stop = startHealthCheckLoop();
      try {
        await new Promise((resolve) => setTimeout(resolve, 80));
      } finally {
        stop();
      }

      expect(pingSpy).not.toHaveBeenCalled();
      expect(registry.getClient("rest-svc-ok")?.status).toBe("healthy");
    } finally {
      pingSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// mcpUpstream.ping() argument construction (lines 23-30)
// ---------------------------------------------------------------------------

describe("checkBatch — mcpUpstream.ping() call arguments", () => {
  afterEach(() => {
    clearUpstreamAuth("mcp-svc-fallback");
  });

  // Kills mutant ids 15 (ObjectLiteral -> `{}`, the whole ping-args object),
  // 16 (LogicalOperator on `client.mcpUrl ?? client.base_url` -> `&&`), 17
  // (LogicalOperator on `client.mcpTransport ?? "streamable-http"` -> `&&`),
  // 18 (StringLiteral `"streamable-http"` -> `""`), and 19 (LogicalOperator
  // on `getUpstreamAuthHeaders(...) ?? undefined` -> `&&`).
  //
  // Registers an MCP client, then clears `mcpUrl`/`mcpTransport` directly on
  // the live registry object (registerMcp always sets both, so this is the
  // only way to exercise the `??` fallback arms) and configures a real
  // upstream credential so `getUpstreamAuthHeaders` returns a *truthy*
  // headers object — the case that distinguishes `??` from `&&` (with a
  // truthy left side, `??` keeps it while `&&` evaluates to the right side,
  // `undefined`).
  test("ping is called with name/url/transport/resolvedIp/authHeaders, using fallbacks", async () => {
    await registerMcpClient("mcp-svc-fallback", "http://mcp.test/mcp", "streamable-http", "10.0.0.2");

    const client = registry.getClient("mcp-svc-fallback");
    expect(client).toBeDefined();
    // Force the `??` fallback arms: clear the primary fields registerMcp set,
    // leaving base_url (always populated) as the only usable URL, and no
    // explicit transport.
    client!.mcpUrl = undefined;
    client!.mcpTransport = undefined;

    setUpstreamAuth("mcp-svc-fallback", "bearer", { token: "secret-xyz" }, null);

    let capturedArgs: unknown;
    const pingSpy = spyOn(mcpUpstream, "ping").mockImplementation(async (p) => {
      capturedArgs = p;
      return true;
    });

    try {
      const { startHealthCheckLoop } = await import("../../observability/health.js");
      const stop = startHealthCheckLoop();
      try {
        await new Promise((resolve) => setTimeout(resolve, 80));
      } finally {
        stop();
      }

      expect(pingSpy).toHaveBeenCalled();
      expect(capturedArgs).toEqual({
        name: "mcp-svc-fallback",
        url: client!.base_url,
        transport: "streamable-http",
        resolvedIp: "10.0.0.2",
        authHeaders: { Authorization: "Bearer secret-xyz" },
      });
    } finally {
      pingSpy.mockRestore();
    }
  });
});
