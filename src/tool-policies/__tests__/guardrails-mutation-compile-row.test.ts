/**
 * Stryker mutation-kill backstop for src/tool-policies/guardrails.ts, targeting
 * compileDenyPattern's cache-hit branch + "i" flag + catch-fallback,
 * rowToGuardrails's null-json/blockSecrets-boundary/all-empty-collapses-to-null
 * behavior, getGuardrailsForClient (zero prior coverage), and
 * _internalsForTesting.clearDenyPatternCache.
 *
 * compileDenyPattern itself isn't exported, so its branches are exercised
 * indirectly through the exported checkInputGuardrails, which is the only
 * caller.
 *
 * Documented equivalent considered and rejected as equivalent (i.e. a real
 * test was written instead): denyPatternCache.clear()'s body being emptied.
 * Regex compilation is a pure function of the pattern string, so a cleared
 * vs. stale-but-identical cache entry can't be told apart by checkInputGuardrails's
 * *return value* alone. But the cache's whole purpose is to avoid re-running
 * `new RegExp(...)`, so clearing it IS observable at the RegExp-construction
 * call site: spyOn(globalThis, "RegExp") (call-through, same technique this
 * codebase already uses for spyOn(Date, "now") / spyOn(Math, "random") in
 * load-balancer-mutation.test.ts) lets a test assert that re-checking the same
 * deny pattern after clearDenyPatternCache() constructs a brand-new RegExp
 * instead of reusing the cached one — which fails if the mutant empties the
 * clear() body, since the stale cache entry would still short-circuit
 * compileDenyPattern's `.has(pattern)` check.
 */
import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { getDb, __resetDbForTesting } from "../../db/connection.js";
import { registry } from "../../mcp/registry.js";
import { removeCircuitBreaker } from "../../middleware/circuit-breaker.js";
import {
  getGuardrails,
  setGuardrails,
  getGuardrailsForClient,
  checkInputGuardrails,
  _internalsForTesting,
} from "../../tool-policies/guardrails.js";
import type { RestToolDefinition } from "../../mcp/types.js";

const CLIENT = "gr-mutation-client";

function makeTool(overrides: Partial<RestToolDefinition> = {}): RestToolDefinition {
  return {
    name: "do-thing",
    method: "POST",
    endpoint: "/thing",
    description: "does a thing",
    inputSchema: { type: "object", properties: { note: { type: "string" } } },
    ...overrides,
  };
}
async function reg(tools: RestToolDefinition[] = [makeTool()]): Promise<void> {
  await registry.register(CLIENT, tools, "http://1.2.3.4/health", "1.2.3.4", "http://1.2.3.4", "1.2.3.4");
}

beforeEach(async () => {
  for (const c of registry.listClients()) await registry.unregister(c.name);
  __resetDbForTesting();
  removeCircuitBreaker(CLIENT);
  _internalsForTesting.clearDenyPatternCache();
});
afterEach(async () => {
  for (const c of registry.listClients()) await registry.unregister(c.name);
  __resetDbForTesting();
  removeCircuitBreaker(CLIENT);
  _internalsForTesting.clearDenyPatternCache();
});

describe("compileDenyPattern — cache-hit branch (via checkInputGuardrails)", () => {
  test("the SAME pattern matches correctly on a second call, proving the cached regex still works", () => {
    const cfg = { denyPatterns: ["\\bDROP\\b"], blockSecrets: false, scanResponses: false };
    // First call: cache miss, compiles and caches.
    expect(checkInputGuardrails(cfg, { note: "please DROP now" }).blocked).toBe(true);
    // Second call, same cfg.denyPatterns array/string: cache hit path.
    expect(checkInputGuardrails(cfg, { note: "please DROP now" }).blocked).toBe(true);
    // And the cached entry must still correctly reject non-matching input (not a stale true).
    expect(checkInputGuardrails(cfg, { note: "all clear" }).blocked).toBe(false);
  });
});

describe("compileDenyPattern — case-insensitive 'i' flag (via checkInputGuardrails)", () => {
  test("a lowercase deny pattern matches differently-cased input", () => {
    const cfg = { denyPatterns: ["hello"], blockSecrets: false, scanResponses: false };
    expect(checkInputGuardrails(cfg, { note: "HELLO WORLD" }).blocked).toBe(true);
  });

  test("a mixed-case deny pattern matches all-lowercase input", () => {
    const cfg = { denyPatterns: ["HeLLo"], blockSecrets: false, scanResponses: false };
    expect(checkInputGuardrails(cfg, { note: "hello there" }).blocked).toBe(true);
  });
});

describe("compileDenyPattern — invalid regex compiles to null, never throws (via checkInputGuardrails)", () => {
  test("an unbalanced-parenthesis pattern does not throw and never matches", () => {
    const cfg = { denyPatterns: ["("], blockSecrets: false, scanResponses: false };
    expect(() => checkInputGuardrails(cfg, { note: "anything at all" })).not.toThrow();
    expect(checkInputGuardrails(cfg, { note: "anything at all" }).blocked).toBe(false);
  });

  test("an invalid pattern alongside a valid one: the valid one still blocks", () => {
    const cfg = { denyPatterns: ["(", "\\bDROP\\b"], blockSecrets: false, scanResponses: false };
    expect(checkInputGuardrails(cfg, { note: "please DROP now" }).blocked).toBe(true);
  });
});

describe("rowToGuardrails — null deny_patterns_json becomes a genuine empty array", () => {
  test("setGuardrails with no deny patterns persists NULL, getGuardrails reads back []", async () => {
    await reg();
    expect(setGuardrails(CLIENT, "do-thing", { denyPatterns: [], blockSecrets: true, scanResponses: false })).toBe(
      true,
    );
    const cfg = getGuardrails(CLIENT, "do-thing");
    expect(cfg).not.toBeNull();
    expect(cfg?.denyPatterns).toEqual([]);
  });
});

describe("rowToGuardrails — block_secrets boundary", () => {
  test("blockSecrets false (only scanResponses set) reads back exactly false, not forced true", async () => {
    await reg();
    expect(setGuardrails(CLIENT, "do-thing", { denyPatterns: [], blockSecrets: false, scanResponses: true })).toBe(
      true,
    );
    const cfg = getGuardrails(CLIENT, "do-thing");
    expect(cfg?.blockSecrets).toBe(false);
    expect(cfg).toEqual({ denyPatterns: [], blockSecrets: false, scanResponses: true });
  });
});

describe("rowToGuardrails — an all-nothing-enabled row collapses to null, not a hollow object", () => {
  test("clearing every flag makes getGuardrails return null exactly", async () => {
    await reg();
    setGuardrails(CLIENT, "do-thing", { denyPatterns: ["\\bDROP\\b"], blockSecrets: true, scanResponses: true });
    expect(getGuardrails(CLIENT, "do-thing")).not.toBeNull();

    expect(setGuardrails(CLIENT, "do-thing", { denyPatterns: [], blockSecrets: false, scanResponses: false })).toBe(
      true,
    );
    expect(getGuardrails(CLIENT, "do-thing")).toBeNull();
  });
});

describe("getGuardrailsForClient — zero prior coverage", () => {
  test("returns every configured tool keyed by name, with exact configs, omitting unconfigured tools", async () => {
    await reg([makeTool({ name: "tool-a" }), makeTool({ name: "tool-b" }), makeTool({ name: "tool-c" })]);

    setGuardrails(CLIENT, "tool-a", { denyPatterns: ["\\bDROP\\b"], blockSecrets: false, scanResponses: false });
    setGuardrails(CLIENT, "tool-b", { denyPatterns: [], blockSecrets: true, scanResponses: false });
    // tool-c deliberately left unconfigured.

    const result = getGuardrailsForClient(CLIENT);

    expect(result).toEqual({
      "tool-a": { denyPatterns: ["\\bDROP\\b"], blockSecrets: false, scanResponses: false },
      "tool-b": { denyPatterns: [], blockSecrets: true, scanResponses: false },
    });
    expect(Object.prototype.hasOwnProperty.call(result, "tool-c")).toBe(false);
  });

  test("a client with a guardrail row that collapses to null (all-empty) is omitted from the result", async () => {
    await reg([makeTool({ name: "tool-a" })]);
    // Directly insert an all-empty row, bypassing setGuardrails (which would just
    // DELETE instead of writing this row) — exercises rowToGuardrails' null-collapse
    // inside the getGuardrailsForClient loop specifically, not just getGuardrails.
    getDb()
      .query(
        `INSERT INTO tool_guardrails (client_name, tool_name, deny_patterns_json, block_secrets, scan_responses, updated_at)
         VALUES (?, ?, NULL, 0, 0, ?)`,
      )
      .run(CLIENT, "tool-a", Date.now());

    expect(getGuardrailsForClient(CLIENT)).toEqual({});
  });

  test("a client with no guardrail rows at all returns an empty object", async () => {
    await reg();
    expect(getGuardrailsForClient(CLIENT)).toEqual({});
  });
});

describe("_internalsForTesting.clearDenyPatternCache — observable via RegExp construction count", () => {
  test("clearing the cache forces re-compilation on the next lookup of the same pattern", () => {
    const cfg = { denyPatterns: ["hello"], blockSecrets: false, scanResponses: false };

    // Warm the cache: first check on this pattern compiles + caches it.
    expect(checkInputGuardrails(cfg, { note: "hello there" }).blocked).toBe(true);

    const spy = spyOn(globalThis, "RegExp");
    try {
      // Cache hit: no new RegExp constructed.
      checkInputGuardrails(cfg, { note: "hello there" });
      expect(spy).toHaveBeenCalledTimes(0);

      _internalsForTesting.clearDenyPatternCache();

      // Cache was cleared: this lookup must reconstruct the RegExp.
      checkInputGuardrails(cfg, { note: "hello there" });
      expect(spy).toHaveBeenCalledTimes(1);

      // And a subsequent lookup (now re-cached) doesn't construct again.
      checkInputGuardrails(cfg, { note: "hello there" });
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });
});
