/**
 * Stryker mutation-testing backstop — cluster RG4 (src/mcp/registration.ts
 * L400-498): performMcpRegistration — validates name/mcp_url/mcp_transport,
 * SSRF-validates mcp_url, discovers tools from the upstream MCP server, and
 * calls registry.registerMcp(...).
 *
 * `discoverToolsFromMcpServer` (mcp-discovery.ts) and `validateBackendUrl`
 * (net/ip-validator.ts) are spied via `spyOn` on their module namespace
 * objects rather than exercised against a real MCP upstream connection —
 * registration.ts imports and calls both as plain named imports (not via a
 * namespace object), and this codebase already relies on that exact
 * technique working for directly-imported functions (see
 * src/proxy/__tests__/backends.test.ts's `ipValidatorMod` spy on the very
 * same `validateBackendUrl`, and registry-mutation-rc9.test.ts's
 * `circuitBreakerMod` spy on `removeCircuitBreaker`).
 *
 * House convention (see src/security/__tests__/compare.test.ts and
 * src/mcp/__tests__/registry-mutation-rc*.test.ts): fresh in-memory SQLite +
 * a fully drained live registry before every test (unregister() only tears
 * down in-memory state, so __resetDbForTesting() is still required to avoid
 * leaking persisted enabled/guards/team rows across tests reusing generic
 * names). Every test is written against a concrete surviving mutant, cited
 * by line:mutator in its own describe/test title against the CURRENT
 * on-disk file (re-read at authoring time — the task's mutant list's line
 * numbers drift by ~1 in a few spots vs. what's actually on disk today).
 *
 * Client-name prefix: rg4-
 */
import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";

import { performMcpRegistration } from "../../mcp/registration.js";
import { registry } from "../../mcp/registry.js";
import { __resetDbForTesting } from "../../db/connection.js";
import { config } from "../../config.js";
import * as mcpDiscoveryMod from "../../mcp/mcp-discovery.js";
import * as ipValidatorMod from "../../net/ip-validator.js";
import * as upstreamAuthMod from "../../backend-auth/upstream-auth.js";
import * as logger from "../../logger.js";
import type { DiscoveredMcpTool } from "../../mcp/mcp-discovery.js";

const PINNED_IP = "10.20.30.40";
const MCP_URL = "http://rg4-upstream.example/mcp";

function makeTool(overrides: Partial<DiscoveredMcpTool> = {}): DiscoveredMcpTool {
  return {
    name: "t1",
    upstreamName: "upstream-t1",
    description: "a discovered tool",
    inputSchema: { type: "object", properties: {} },
    ...overrides,
  };
}

function makeManyTools(n: number): DiscoveredMcpTool[] {
  return Array.from({ length: n }, (_, i) =>
    makeTool({ name: `t${i}`, upstreamName: `upstream-t${i}`, description: `tool ${i}` }),
  );
}

let validateSpy: ReturnType<typeof spyOn<typeof ipValidatorMod, "validateBackendUrl">>;
let discoverSpy: ReturnType<typeof spyOn<typeof mcpDiscoveryMod, "discoverToolsFromMcpServer">>;
let authSpy: ReturnType<typeof spyOn<typeof upstreamAuthMod, "getUpstreamAuthHeaders">>;

async function drainRegistry(): Promise<void> {
  for (const client of registry.listClients()) {
    await registry.unregister(client.name);
  }
  __resetDbForTesting();
}

beforeEach(async () => {
  await drainRegistry();
  // Sane defaults every test can override with mockResolvedValueOnce /
  // mockReturnValueOnce — a real DNS-resolving validateBackendUrl or a real
  // MCP-connecting discoverToolsFromMcpServer would be slow/flaky/offline
  // in a unit test, so these stand in for a healthy upstream by default.
  validateSpy = spyOn(ipValidatorMod, "validateBackendUrl").mockResolvedValue({ valid: true, resolvedIp: PINNED_IP });
  discoverSpy = spyOn(mcpDiscoveryMod, "discoverToolsFromMcpServer").mockResolvedValue([makeTool()]);
  authSpy = spyOn(upstreamAuthMod, "getUpstreamAuthHeaders").mockReturnValue(null);
});

afterEach(async () => {
  validateSpy.mockRestore();
  discoverSpy.mockRestore();
  authSpy.mockRestore();
  await drainRegistry();
});

// ---------------------------------------------------------------------------
// transportRaw default — L408 `typeof body.mcp_transport === "string" ?
// body.mcp_transport : "streamable-http"` (ConditionalExpression, EqualityOperator,
// StringLiteral)
// ---------------------------------------------------------------------------

describe("performMcpRegistration — L408 transportRaw ternary", () => {
  test("an explicit mcp_transport is USED, not silently defaulted (kills ConditionalExpression-forced-false + EqualityOperator === -> !==)", async () => {
    const name = "rg4-transport-explicit";
    const result = await performMcpRegistration({ name, mcp_url: MCP_URL, mcp_transport: "sse" }, undefined, null);
    expect(result.ok).toBe(true);
    expect(registry.getClientDetail(name)?.mcpTransport).toBe("sse");
  });

  test('an omitted mcp_transport defaults to EXACTLY "streamable-http" (kills ConditionalExpression-forced-true + StringLiteral default swap)', async () => {
    const name = "rg4-transport-default";
    const result = await performMcpRegistration({ name, mcp_url: MCP_URL }, undefined, null);
    expect(result.ok).toBe(true);
    expect(registry.getClientDetail(name)?.mcpTransport).toBe("streamable-http");
  });
});

// ---------------------------------------------------------------------------
// name validation — L410-416 `if (typeof name !== "string" || !name)`
// ---------------------------------------------------------------------------

describe("performMcpRegistration — L410-416 name guard", () => {
  test("a non-string TRUTHY name (42) is rejected on the typeof check alone (kills || -> && swap)", async () => {
    const result = await performMcpRegistration({ name: 42, mcp_url: MCP_URL }, undefined, "req-1");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(400);
      expect(result.body.error.code).toBe("VALIDATION_ERROR");
      expect(result.body.error.message).toBe("Missing required field: name");
      expect(result.body.error.request_id).toBe("req-1");
    }
  });

  test("an empty-string name is rejected on the falsy check (kills !name negation / dropped-clause mutants)", async () => {
    const result = await performMcpRegistration({ name: "", mcp_url: MCP_URL }, undefined, null);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(400);
      expect(result.body.error.code).toBe("VALIDATION_ERROR");
      expect(result.body.error.message).toBe("Missing required field: name");
    }
  });
});

// ---------------------------------------------------------------------------
// mcp_url validation — L419 `if (typeof mcpUrl !== "string" ||
// (!mcpUrl.startsWith("http://") && !mcpUrl.startsWith("https://")))`
// ---------------------------------------------------------------------------

describe("performMcpRegistration — L419 mcp_url scheme guard", () => {
  test("a non-string TRUTHY mcp_url is rejected on the typeof check alone (kills outer || -> && swap)", async () => {
    const result = await performMcpRegistration({ name: "rg4-url-nonstring", mcp_url: 42 }, undefined, null);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(400);
      expect(result.body.error.code).toBe("VALIDATION_ERROR");
      expect(result.body.error.message).toBe("mcp_url must start with http:// or https://");
    }
  });

  test("a string mcp_url matching NEITHER scheme is rejected (e.g. ftp://x)", async () => {
    const result = await performMcpRegistration({ name: "rg4-url-neither", mcp_url: "ftp://x" }, undefined, null);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(400);
      expect(result.body.error.code).toBe("VALIDATION_ERROR");
      expect(result.body.error.message).toBe("mcp_url must start with http:// or https://");
    }
  });

  test('an http://-only mcp_url is ACCEPTED (kills inner && -> || swap + startsWith("http://") MethodExpression/BooleanLiteral mutants)', async () => {
    const name = "rg4-url-http-only";
    const result = await performMcpRegistration({ name, mcp_url: "http://good.example/mcp" }, undefined, null);
    expect(result.ok).toBe(true);
    // Would have been wrongly rejected by the "must ALSO start with https://"
    // (&&-swapped) mutant, since this url starts with http:// but not https://.
    expect(registry.getClientDetail(name)?.mcpUrl).toBe("http://good.example/mcp");
  });

  test('an https://-only mcp_url is ACCEPTED (mirror of the http:// case, pins startsWith("https://"))', async () => {
    const name = "rg4-url-https-only";
    const result = await performMcpRegistration({ name, mcp_url: "https://good.example/mcp" }, undefined, null);
    expect(result.ok).toBe(true);
    expect(registry.getClientDetail(name)?.mcpUrl).toBe("https://good.example/mcp");
  });
});

// ---------------------------------------------------------------------------
// mcp_transport validation — L432 `if (transportRaw !== "streamable-http" &&
// transportRaw !== "sse")`
// ---------------------------------------------------------------------------

describe("performMcpRegistration — L432 mcp_transport allow-list", () => {
  test('"streamable-http" is accepted and proceeds', async () => {
    const name = "rg4-transport-streamable";
    const result = await performMcpRegistration(
      { name, mcp_url: MCP_URL, mcp_transport: "streamable-http" },
      undefined,
      null,
    );
    expect(result.ok).toBe(true);
    expect(registry.getClientDetail(name)?.mcpTransport).toBe("streamable-http");
  });

  test('"sse" is accepted and proceeds (both valid values individually pin the && combination, not an ||-style mutant)', async () => {
    const name = "rg4-transport-sse-valid";
    const result = await performMcpRegistration({ name, mcp_url: MCP_URL, mcp_transport: "sse" }, undefined, null);
    expect(result.ok).toBe(true);
    expect(registry.getClientDetail(name)?.mcpTransport).toBe("sse");
  });

  test("an unrecognized transport (websocket) is rejected with the exact message", async () => {
    const result = await performMcpRegistration(
      { name: "rg4-transport-bad", mcp_url: MCP_URL, mcp_transport: "websocket" },
      undefined,
      null,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(400);
      expect(result.body.error.code).toBe("VALIDATION_ERROR");
      expect(result.body.error.message).toBe("mcp_transport must be 'streamable-http' or 'sse'");
    }
  });
});

// ---------------------------------------------------------------------------
// SSRF validation on mcpUrl — L448-458
// ---------------------------------------------------------------------------

describe("performMcpRegistration — L448-458 SSRF validation + IP pin", () => {
  test("validateBackendUrl invalid -> exact `Invalid mcp_url: <reason>` message", async () => {
    validateSpy.mockResolvedValueOnce({ valid: false, reason: "blocked-by-policy" });
    const result = await performMcpRegistration({ name: "rg4-ssrf-blocked", mcp_url: MCP_URL }, undefined, "req-ssrf");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(400);
      expect(result.body.error.code).toBe("VALIDATION_ERROR");
      expect(result.body.error.message).toBe("Invalid mcp_url: blocked-by-policy");
      expect(result.body.error.request_id).toBe("req-ssrf");
    }
    expect(discoverSpy).not.toHaveBeenCalled();
  });

  test("validateBackendUrl valid -> resolvedIp is extracted correctly and forwarded as discovery's pinned IP", async () => {
    validateSpy.mockResolvedValueOnce({ valid: true, resolvedIp: "5.6.7.8" });
    const name = "rg4-ssrf-pin";
    const result = await performMcpRegistration({ name, mcp_url: MCP_URL }, undefined, null);
    expect(result.ok).toBe(true);
    expect(discoverSpy).toHaveBeenCalledTimes(1);
    const [connParams] = discoverSpy.mock.calls[0]!;
    expect(connParams.resolvedIp).toBe("5.6.7.8");
    expect(registry.getClientDetail(name)?.resolvedIp).toBe("5.6.7.8");
  });
});

// ---------------------------------------------------------------------------
// peerIp default — L459 `const ip = peerIp || "127.0.0.1";`
// ---------------------------------------------------------------------------

describe('performMcpRegistration — L459 `peerIp || "127.0.0.1"`', () => {
  test("a real peerIp is used, not the default", async () => {
    const name = "rg4-ip-real";
    const result = await performMcpRegistration({ name, mcp_url: MCP_URL }, "203.0.113.9", null);
    expect(result.ok).toBe(true);
    expect(registry.getClientDetail(name)?.ip).toBe("203.0.113.9");
  });

  test("an undefined peerIp defaults to EXACTLY 127.0.0.1", async () => {
    const name = "rg4-ip-default";
    const result = await performMcpRegistration({ name, mcp_url: MCP_URL }, undefined, null);
    expect(result.ok).toBe(true);
    expect(registry.getClientDetail(name)?.ip).toBe("127.0.0.1");
  });
});

// ---------------------------------------------------------------------------
// discoverToolsFromMcpServer call params + auth headers — L462-475
// ---------------------------------------------------------------------------

describe("performMcpRegistration — L462-475 discoverToolsFromMcpServer call", () => {
  test("is called with the exact 5-field McpConnParams object and timeoutMs option", async () => {
    const name = "rg4-discover-params";
    authSpy.mockReturnValueOnce(null);
    const result = await performMcpRegistration({ name, mcp_url: MCP_URL, mcp_transport: "sse" }, undefined, null);
    expect(result.ok).toBe(true);
    expect(discoverSpy).toHaveBeenCalledTimes(1);
    const [connParams, opts] = discoverSpy.mock.calls[0]!;
    expect(connParams).toEqual({
      name,
      url: MCP_URL,
      transport: "sse",
      resolvedIp: PINNED_IP,
      authHeaders: undefined,
    });
    // Specifically undefined, not null -- pins the `?? undefined` mutant target.
    expect(connParams.authHeaders).toBeUndefined();
    expect(connParams.authHeaders).not.toBeNull();
    expect(opts).toEqual({ timeoutMs: config.toolCallTimeoutMs });
  });

  test("getUpstreamAuthHeaders is called with the client name, and a configured (non-null) result is forwarded unchanged", async () => {
    const name = "rg4-discover-auth";
    const headers = { Authorization: "Bearer rg4-token" };
    authSpy.mockReturnValueOnce(headers);
    const result = await performMcpRegistration({ name, mcp_url: MCP_URL }, undefined, null);
    expect(result.ok).toBe(true);
    expect(authSpy).toHaveBeenCalledWith(name);
    const [connParams] = discoverSpy.mock.calls[0]!;
    expect(connParams.authHeaders).toEqual(headers);
  });

  test("an empty discovered array -> exact `No tools discovered from MCP upstream` DISCOVERY_ERROR", async () => {
    discoverSpy.mockResolvedValueOnce([]);
    const result = await performMcpRegistration(
      { name: "rg4-discover-empty", mcp_url: MCP_URL },
      undefined,
      "req-empty",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(400);
      expect(result.body.error.code).toBe("DISCOVERY_ERROR");
      expect(result.body.error.message).toBe("No tools discovered from MCP upstream");
      expect(result.body.error.request_id).toBe("req-empty");
    }
  });
});

// ---------------------------------------------------------------------------
// maxToolsPerClient boundary — L476-490
// ---------------------------------------------------------------------------

describe("performMcpRegistration — L476-490 maxToolsPerClient boundary", () => {
  test("exactly at the cap succeeds (boundary is >, not >=)", async () => {
    const cap = config.maxToolsPerClient;
    discoverSpy.mockResolvedValueOnce(makeManyTools(cap));
    const name = "rg4-cap-exact";
    const result = await performMcpRegistration({ name, mcp_url: MCP_URL }, undefined, null);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.body.tools_count).toBe(cap);
    }
  });

  test("one over the cap is rejected with the exact interpolated message", async () => {
    const cap = config.maxToolsPerClient;
    const over = cap + 1;
    discoverSpy.mockResolvedValueOnce(makeManyTools(over));
    const result = await performMcpRegistration({ name: "rg4-cap-over", mcp_url: MCP_URL }, undefined, "req-cap");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(400);
      expect(result.body.error.code).toBe("VALIDATION_ERROR");
      expect(result.body.error.message).toBe(`MCP upstream exposes ${over} tools, exceeds maximum of ${cap}`);
      expect(result.body.error.request_id).toBe("req-cap");
    }
  });
});

// ---------------------------------------------------------------------------
// catch block + success response — L491-497
// ---------------------------------------------------------------------------

describe("performMcpRegistration — L491-497 catch block + success response", () => {
  test("a discoverToolsFromMcpServer rejection surfaces as DISCOVERY_ERROR with the thrown error's own message (always this code, unlike the REST path's conditional code)", async () => {
    discoverSpy.mockRejectedValueOnce(new Error("upstream unreachable: ECONNREFUSED"));
    const result = await performMcpRegistration({ name: "rg4-catch-error", mcp_url: MCP_URL }, undefined, "req-catch");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(400);
      expect(result.body.error.code).toBe("DISCOVERY_ERROR");
      expect(result.body.error.message).toBe("upstream unreachable: ECONNREFUSED");
      expect(result.body.error.request_id).toBe("req-catch");
    }
  });

  test("a non-Error throw falls back to String(err) (kills the instanceof Error ternary's else-branch)", async () => {
    discoverSpy.mockImplementationOnce(() => Promise.reject("just a string rejection"));
    const result = await performMcpRegistration({ name: "rg4-catch-nonerror", mcp_url: MCP_URL }, undefined, null);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.body.error.code).toBe("DISCOVERY_ERROR");
      expect(result.body.error.message).toBe("just a string rejection");
    }
  });

  test('a successful call logs + responds with source:"mcp" exactly and the correct tools_count', async () => {
    const logSpy = spyOn(logger, "log").mockImplementation(() => {});
    try {
      const name = "rg4-success";
      discoverSpy.mockResolvedValueOnce([
        makeTool({ name: "a" }),
        makeTool({ name: "b", upstreamName: "up-b" }),
        makeTool({ name: "c", upstreamName: "up-c" }),
      ]);
      const result = await performMcpRegistration({ name, mcp_url: MCP_URL }, undefined, null);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.status).toBe(200);
        expect(result.body).toEqual({ status: "registered", name, tools_count: 3, source: "mcp" });
      }
      expect(logSpy).toHaveBeenCalledWith("info", "MCP upstream registered", {
        name,
        tools_count: 3,
        source: "mcp",
      });
    } finally {
      logSpy.mockRestore();
    }
  });
});
