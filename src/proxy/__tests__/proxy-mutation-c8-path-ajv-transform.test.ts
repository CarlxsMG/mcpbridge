/**
 * Stryker mutation-testing backstop — cluster C8 (proxy.ts L749-816):
 * endpoint path-param substitution, post-substitution path-traversal
 * rejection, Ajv argument-validation error formatting, and the declarative
 * request-transform "has ops" boundary. Every assertion drives through the
 * public proxyToolCall() entry point per the repo's established convention
 * (see proxy.test.ts / transform.test.ts).
 *
 * Three mutants investigated and left untested with inline NOTEs (see the
 * "path-traversal rejection" and "Ajv argument validation error message"
 * describe blocks below): L774 (segment-decode `catch{}` body), L789
 * (`validate.errors?.[0]` optional chaining), and L791 (`"unknown error"`
 * fallback literal). All three are equivalent mutants — L774 because
 * `decoded`'s only read site can never distinguish `undefined` from a
 * `seg` that necessarily contains "%" (so never equals ".." or "."); L789
 * and L791 because Ajv's compiled validator only ever sets `.errors` to a
 * non-null, non-empty array when `valid === false` (verified empirically
 * across 17+ schema/input shapes against the exact Ajv instance config
 * used in proxy.ts). L774 and L789 are additionally auto-killed at compile
 * time by Stryker's `@stryker-mutator/typescript-checker` plugin regardless
 * (confirmed via standalone `bunx tsc --noEmit --strict` repros): TS2454
 * "used before being assigned" for L774, TS18049 "possibly 'null' or
 * 'undefined'" for L789.
 */
import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { registry } from "../../mcp/registry.js";
import { removeCircuitBreaker } from "../../middleware/circuit-breaker.js";
import { config } from "../../config.js";
import { __resetDbForTesting } from "../../db/connection.js";
import { proxyToolCall } from "../../proxy/proxy.js";
import { setToolTransform } from "../../proxy/transform.js";
import * as transformMod from "../../proxy/transform.js";
import type { RestToolDefinition } from "../../mcp/types.js";

// Client names must match /^[a-z0-9][a-z0-9_-]{0,62}$/ (lowercase only) — the
// assigned prefix "mutC8ajv" is lowercased here to satisfy that constraint.
const CLIENT = "mutc8ajv";

function makeTool(overrides: Partial<RestToolDefinition> = {}): RestToolDefinition {
  return {
    name: "get-item",
    method: "GET",
    endpoint: "/item",
    description: "d",
    inputSchema: { type: "object", properties: {} },
    ...overrides,
  };
}

async function reg(tools: RestToolDefinition[] = [makeTool()]): Promise<void> {
  await registry.register(CLIENT, tools, "http://1.2.3.4/health", "1.2.3.4", "http://1.2.3.4", "1.2.3.4");
}

const originalFetch = globalThis.fetch;
function resetAll(): void {
  (config as Record<string, unknown>).retryMaxAttempts = 0;
  (config as Record<string, unknown>).retryBaseDelayMs = 1;
  __resetDbForTesting();
  removeCircuitBreaker(CLIENT);
  globalThis.fetch = originalFetch;
}
beforeEach(async () => {
  for (const c of registry.listClients()) await registry.unregister(c.name);
  resetAll();
});
afterEach(async () => {
  for (const c of registry.listClients()) await registry.unregister(c.name);
  resetAll();
});

function okFetch(body: unknown = { ok: true }): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

// ---------------------------------------------------------------------------
// Path-param substitution (L751 regex, L753 guard, L757 fallback literal)
// ---------------------------------------------------------------------------
describe("endpoint path-param substitution", () => {
  test(
    "two params, both supplied, are substituted and stripped from the query string " +
      "(kills L751 regex charclass/anchoring/`g`-flag mutants + L753 'value !== undefined' guard)",
    async () => {
      await reg([
        makeTool({
          name: "get-nested",
          endpoint: "/orgs/:orgId/users/:user_id2",
          inputSchema: { type: "object", properties: {} },
        }),
      ]);
      let seenUrl = "";
      globalThis.fetch = (async (url: string) => {
        seenUrl = String(url);
        return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
      }) as unknown as typeof fetch;
      const r = await proxyToolCall(`${CLIENT}__get-nested`, { orgId: "a1", user_id2: "42" });
      expect(r.isError).toBeUndefined();
      // Both params substituted (global replace, not just the first).
      expect(seenUrl).toContain("/orgs/a1/users/42");
      // Consumed params must not leak into the query string (guard deleted them).
      expect(seenUrl).not.toContain("?");
      expect(seenUrl).not.toContain("orgId");
      expect(seenUrl).not.toContain("user_id2");
    },
  );

  test("a missing param leaves the literal ':paramName' placeholder untouched (kills L757 StringLiteral '``')", async () => {
    await reg([
      makeTool({
        name: "get-nested",
        endpoint: "/orgs/:orgId/users/:user_id2",
        inputSchema: { type: "object", properties: {} },
      }),
    ]);
    let seenUrl = "";
    globalThis.fetch = (async (url: string) => {
      seenUrl = String(url);
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const r = await proxyToolCall(`${CLIENT}__get-nested`, {});
    expect(r.isError).toBeUndefined();
    expect(seenUrl).toContain("/orgs/:orgId/users/:user_id2");
  });
});

// ---------------------------------------------------------------------------
// Post-substitution path-traversal rejection (L767-778)
// ---------------------------------------------------------------------------
describe("path-traversal rejection after substitution", () => {
  // A literal ".." argument value is NOT percent-encoded by encodeURIComponent
  // (both '.' characters are in the RFC3986 "unreserved" set), so it survives
  // substitution as a real ".." path segment — this is exactly the runtime
  // check L767-778 guards against.
  test(
    "a param value of '..' produces an invalid-path rejection with the exact message " +
      "(kills L767/L770/L772/L777-OR->AND/L778 StringLiteral+ObjectLiteral+BooleanLiteral)",
    async () => {
      await reg([
        makeTool({ name: "get-item", endpoint: "/users/:id", inputSchema: { type: "object", properties: {} } }),
      ]);
      globalThis.fetch = okFetch();
      const r = await proxyToolCall(`${CLIENT}__get-item`, { id: ".." });
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toBe("Tool endpoint resolved to invalid path");
    },
  );

  test("a param value of '.' is independently rejected too (kills L777 '||'->'&&' — neither alone would fire under AND)", async () => {
    await reg([
      makeTool({ name: "get-item", endpoint: "/users/:id", inputSchema: { type: "object", properties: {} } }),
    ]);
    globalThis.fetch = okFetch();
    const r = await proxyToolCall(`${CLIENT}__get-item`, { id: "." });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe("Tool endpoint resolved to invalid path");
  });

  test(
    "a param value merely containing a dot (not an exact '.' or '..' segment) is NOT rejected " +
      "(kills L769 StringLiteral '' — split('/') mutated to split('') would flag any lone '.' character)",
    async () => {
      await reg([
        makeTool({ name: "get-item", endpoint: "/items/:id", inputSchema: { type: "object", properties: {} } }),
      ]);
      let seenUrl = "";
      globalThis.fetch = (async (url: string) => {
        seenUrl = String(url);
        return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
      }) as unknown as typeof fetch;
      const r = await proxyToolCall(`${CLIENT}__get-item`, { id: "a.b" });
      expect(r.isError).toBeUndefined();
      expect(seenUrl).toContain("/items/a.b");
    },
  );

  // NOTE (L774, equivalent mutant, not tested): emptying the segment-decode
  // `catch { decoded = seg; }` block (-> `catch {}`) leaves `decoded` at its
  // `let decoded: string;` default of `undefined` instead of falling back to
  // the raw `seg`. Grepped proxy.ts: `decoded` is read in exactly ONE place
  // afterward — L777, `decoded === ".." || decoded === "."` — so the mutant
  // is only observable if a segment that made `decodeURIComponent` throw
  // could itself literally equal ".." or ".". It can't: decodeURIComponent
  // only throws on a malformed/incomplete "%" escape, so any segment that
  // reaches the catch necessarily CONTAINS a "%" character, and neither ".."
  // nor "." contains one. So the real fallback (`seg`) and the mutant's
  // value (`undefined`) are BOTH always !== ".." and !== "." for every
  // reachable input — no test can distinguish them from the outside.
  // (A qualifying malformed segment has to come from the tool's own endpoint
  // template, e.g. "/foo/%zz/bar" — encodeURIComponent on an arg value never
  // emits an invalid escape — but per the above it wouldn't matter either
  // way, so no such tool is registered here.)
  // Independently verified this mutant is ALSO a TypeScript strict-mode
  // compile error, and so is auto-killed by Stryker's
  // `@stryker-mutator/typescript-checker` plugin (configured in
  // stryker.config.mjs) before any test would even run: reproduced the
  // mutated shape (`let decoded: string; try { decoded = ...; } catch {}` +
  // a later read of `decoded`) in isolation and confirmed `bunx tsc --noEmit
  // --strict` reports TS2454 "Variable 'decoded' is used before being
  // assigned".
});

// ---------------------------------------------------------------------------
// Ajv argument-validation error formatting (L785-795)
// ---------------------------------------------------------------------------
describe("Ajv argument validation error message", () => {
  test(
    "a missing required top-level field yields instancePath '' -> '/' fallback in the message " +
      "(kills L791 StringLiteral '``', ternary/Conditional set, and the '||' LogicalOperator on instancePath)",
    async () => {
      await reg([
        makeTool({
          name: "post-item",
          method: "POST",
          endpoint: "/item",
          inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
        }),
      ]);
      globalThis.fetch = okFetch();
      const r = await proxyToolCall(`${CLIENT}__post-item`, {});
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toBe("Argument validation failed: /: must have required property 'name'");
    },
  );

  test("a wrong-type field yields a non-empty instancePath verbatim (kills L789 OptionalChaining + L791 remaining set)", async () => {
    await reg([
      makeTool({
        name: "post-item",
        method: "POST",
        endpoint: "/item",
        inputSchema: { type: "object", properties: { name: { type: "string" } } },
      }),
    ]);
    globalThis.fetch = okFetch();
    const r = await proxyToolCall(`${CLIENT}__post-item`, { name: 123 });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe("Argument validation failed: /name: must be string");
  });

  // NOTE (L789 optional-chaining + L791 "unknown error" fallback, equivalent
  // mutants, not tested): both share one root cause — whether Ajv's
  // `validate.errors` can ever be null/undefined/empty immediately after a
  // FAILED validate() call (we're inside `if (!valid)` for both). Verified
  // empirically with a standalone script constructing the exact Ajv
  // instance used here (`new Ajv({ allErrors: false, strict: false,
  // removeAdditional: "all", useDefaults: true, coerceTypes: false })` +
  // `addFormats`, matching proxy.ts L75-82 verbatim) and calling validate()
  // across 17+ schema/input shapes chosen to stress this: plain
  // required/type/format/const/enum/multipleOf/uniqueItems violations,
  // anyOf/oneOf/allOf/not/if-then-else composites, propertyNames,
  // dependencies, patternProperties + additionalProperties:false under
  // removeAdditional, a bare boolean-`false` schema, and a oneOf wrapping
  // additionalProperties:false (Ajv's own documented removeAdditional
  // caveat with anyOf/oneOf). In every case where `valid === false`,
  // `.errors` came back as a non-null array with length >= 1 (composite
  // keywords like anyOf/oneOf/propertyNames even returned MULTIPLE errors
  // despite `allErrors: false`, since they need every branch's failure to
  // explain themselves — but never zero). Ajv's compiled validator only
  // assigns `.errors` when its internal `vErrors` accumulator is non-empty,
  // and returns `false` exactly when it did — so `errors[0]` (`firstError`)
  // can never be falsy on this branch: the `?.` on L789 is defensive-only,
  // and the "unknown error" fallback text on L791 is dead code under real
  // Ajv behavior.
  // Independently verified L789 is ALSO a TypeScript strict-null-check
  // compile error when the `?.` is removed — Ajv types `.errors` as
  // `ErrorObject[] | null | undefined`, so a bare `validate.errors[0]`
  // reproduction of the mutated line trips TS18049 ("'validate.errors' is
  // possibly 'null' or 'undefined'") under `bunx tsc --noEmit --strict` —
  // so this mutant is auto-killed by Stryker's
  // `@stryker-mutator/typescript-checker` plugin the same way L774 is,
  // independent of the behavioral-equivalence argument above.
});

// ---------------------------------------------------------------------------
// Declarative request transform — empty-ops boundary (L800)
// ---------------------------------------------------------------------------
describe("declarative request transform — empty request-ops array boundary (L800)", () => {
  const POST_TOOL = makeTool({
    name: "post-x",
    method: "POST",
    endpoint: "/x",
    inputSchema: { type: "object", properties: { a: { type: "string" } } },
  });

  test("request:[] does NOT invoke applyOps (kills L800 'length >= 0' vs 'length > 0' boundary)", async () => {
    await reg([POST_TOOL]);
    setToolTransform(CLIENT, "post-x", { enabled: true, request: [], response: [] });
    const applyOpsSpy = spyOn(transformMod, "applyOps");
    try {
      globalThis.fetch = okFetch();
      const r = await proxyToolCall(`${CLIENT}__post-x`, { a: "1" });
      expect(r.isError).toBeUndefined();
      expect(applyOpsSpy).not.toHaveBeenCalled();
    } finally {
      applyOpsSpy.mockRestore();
    }
  });

  test("request:[{...}] (non-empty) DOES invoke applyOps and visibly mutates the sent body (contrast case)", async () => {
    await reg([POST_TOOL]);
    setToolTransform(CLIENT, "post-x", {
      enabled: true,
      request: [{ op: "set", path: "injected", value: "yes" }],
      response: [],
    });
    const applyOpsSpy = spyOn(transformMod, "applyOps");
    try {
      let sentBody: unknown;
      globalThis.fetch = (async (_url: string, opts: RequestInit) => {
        sentBody = JSON.parse(String(opts.body));
        return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
      }) as unknown as typeof fetch;
      const r = await proxyToolCall(`${CLIENT}__post-x`, { a: "1" });
      expect(r.isError).toBeUndefined();
      expect(applyOpsSpy).toHaveBeenCalledTimes(1);
      expect(sentBody).toEqual({ a: "1", injected: "yes" });
    } finally {
      applyOpsSpy.mockRestore();
    }
  });
});
