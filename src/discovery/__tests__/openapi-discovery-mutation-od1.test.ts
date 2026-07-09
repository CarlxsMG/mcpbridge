/**
 * Stryker mutation-testing backstop for src/discovery/openapi-discovery.ts
 * (domain 6, cluster: "Fetch, size limits, cycle detection, depth-cap BFS",
 * lines 9, 28-99).
 *
 * Baseline: 211 mutants, 108 killed, 103 survived (+1 timeout), 51.18%.
 * The existing suite (openapi-discovery.test.ts / -depth.test.ts / -pin.test.ts)
 * covers the happy path, DNS pinning, the >5MB rejection (well past the cap),
 * a too-deep spec, an exactly-at-cap spec, and a self-referencing-object
 * cyclic reference — but never: the specific "patch"/"delete" VALID_METHODS
 * entries, the exact boundary value of either size check (only "over by 1"
 * is covered, not "exactly at the cap"), a genuinely-YAML-sourced cycle (only
 * a hand-patched JSON.parse is used) with an assertion on `.cause`, a
 * non-TypeError thrown from JSON.stringify, or a shared-but-non-cyclic
 * (aliased) sub-structure reachable via two different paths in the BFS.
 *
 * dereference() is real (not mocked) everywhere below.
 *
 * ---------------------------------------------------------------------------
 * Note on one cited mutant's location: the task brief describes a target at
 * "L95:13-95:27" as `if (depth > maxDepth) throw ...` forced always-true.
 * That textual description does not match the current source at line 95
 * (`if (child !== null && typeof child === "object")`) or at its actual
 * `depth > maxDepth` check (which is at line 90, not 95). Column 13-27 on
 * line 95 (a 14-character span) exactly matches the sub-expression
 * `child !== null` inside the `&&` — i.e. the mutant is
 * `if (true && typeof child === "object")`, not the depth guard. Since
 * `typeof null === "object"` in JS, this specific guard exists purely to
 * exclude `null` values from being pushed onto the BFS queue as if they were
 * objects; forcing it true lets a literal `null` child through, which then
 * blows up on `Object.values(null)` the next time it's dequeued. That is the
 * mutant targeted below (see the "null child" test). Separately, the
 * `depth > maxDepth` guard (real line 90) forced always-true is already
 * killed by the existing "spec at exactly maxJsonDepth does not throw
 * OPENAPI_TOO_DEEP" test in openapi-discovery-depth.test.ts (any such spec
 * would otherwise throw immediately at depth 0), so no new test is needed
 * for that guard here.
 *
 * Note on L86:30-99:6 BlockStatement [Timeout] (the whole depth-cap BFS
 * while-loop body emptied): with an empty body, `queue` is never drained, so
 * *any* call that reaches this code (i.e. almost every existing test) hangs
 * forever — Stryker's own baseline already tags this mutant `[Timeout]`
 * rather than `[Survived]`, meaning it's already being caught (via timeout)
 * by the existing suite. No new test is added for it.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { config } from "../../config.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function mockFetch(spec: unknown, contentType = "application/json"): void {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(spec), {
      status: 200,
      headers: { "content-type": contentType },
    })) as unknown as typeof fetch;
}

function mockFetchRaw(body: string, headers: Record<string, string>): void {
  globalThis.fetch = (async () =>
    new Response(body, {
      status: 200,
      headers,
    })) as unknown as typeof fetch;
}

// ---------------------------------------------------------------------------
// L9:54-9:61 StringLiteral "" ("patch" emptied) and L9:63-9:71 StringLiteral
// "" ("delete" emptied) inside VALID_METHODS = new Set(["get","post","put",
// "patch","delete"]). A spec using BOTH "patch" and "delete" operations
// proves neither is silently excluded from the recognized-method set.
// ---------------------------------------------------------------------------

describe("discoverToolsFromOpenApi — VALID_METHODS recognizes patch and delete", () => {
  test("patch and delete operations are both extracted, not silently excluded", async () => {
    mockFetch({
      openapi: "3.0.0",
      info: { title: "t", version: "1.0.0" },
      paths: {
        "/a": {
          patch: { operationId: "patch-op", summary: "s", responses: { "200": { description: "ok" } } },
        },
        "/b": {
          delete: { operationId: "delete-op", summary: "s", responses: { "200": { description: "ok" } } },
        },
      },
    });

    const { discoverToolsFromOpenApi } = await import("../../discovery/openapi-discovery.js");
    const tools = await discoverToolsFromOpenApi({ openapiUrl: "http://example.com/openapi.json" });

    const byName = Object.fromEntries(tools.map((t) => [t.name, t.method]));
    expect(tools.length).toBe(2);
    expect(byName["patch-op"]).toBe("PATCH");
    expect(byName["delete-op"]).toBe("DELETE");
  });
});

// ---------------------------------------------------------------------------
// L38:7-38:36 EqualityOperator (`contentLength > MAX_SPEC_SIZE` -> `>=`).
// A Content-Length header of EXACTLY 5*1024*1024 must be allowed (the check
// is strictly-greater-than); the actual body is small so nothing else in the
// pipeline can throw a "too large" error instead.
// ---------------------------------------------------------------------------

describe("discoverToolsFromOpenApi — content-length header boundary is exclusive", () => {
  test("a content-length header of exactly 5MB is not rejected as too large", async () => {
    const MAX_SPEC_SIZE = 5 * 1024 * 1024;
    const smallSpec = JSON.stringify({
      openapi: "3.0.0",
      info: { title: "t", version: "1.0.0" },
      paths: {
        "/ping": {
          get: { operationId: "ping-op", summary: "s", responses: { "200": { description: "ok" } } },
        },
      },
    });

    mockFetchRaw(smallSpec, {
      "content-type": "application/json",
      "content-length": String(MAX_SPEC_SIZE),
    });

    const { discoverToolsFromOpenApi } = await import("../../discovery/openapi-discovery.js");
    const tools = await discoverToolsFromOpenApi({ openapiUrl: "http://example.com/openapi.json" });

    expect(tools.map((t) => t.name)).toEqual(["ping-op"]);
  });
});

// ---------------------------------------------------------------------------
// L43:7-43:34 EqualityOperator (`text.length > MAX_SPEC_SIZE` -> `>=`) — the
// SEPARATE real-body-length check (not the header). A real fetched body of
// EXACTLY 5*1024*1024 characters must be allowed through. No content-length
// header override is used here, so this exercises the actual `text.length`
// re-check specifically.
// ---------------------------------------------------------------------------

describe("discoverToolsFromOpenApi — real body-length boundary is exclusive", () => {
  test("a response body of exactly 5MB characters is not rejected as too large", async () => {
    const MAX_SPEC_SIZE = 5 * 1024 * 1024;
    const PLACEHOLDER = "__PAD__";
    const skeleton = {
      openapi: "3.0.0",
      info: { title: "t", version: "1.0.0" },
      paths: {
        "/ping": {
          get: {
            operationId: "ping-op",
            summary: "s",
            responses: { "200": { description: "ok" } },
            "x-pad": PLACEHOLDER,
          },
        },
      },
    };
    const withPlaceholder = JSON.stringify(skeleton);
    const baseLen = withPlaceholder.length - PLACEHOLDER.length;
    const padLen = MAX_SPEC_SIZE - baseLen;
    expect(padLen).toBeGreaterThan(0);
    const text = withPlaceholder.replace(PLACEHOLDER, "a".repeat(padLen));
    expect(text.length).toBe(MAX_SPEC_SIZE);

    mockFetchRaw(text, { "content-type": "application/json" });

    const { discoverToolsFromOpenApi } = await import("../../discovery/openapi-discovery.js");
    const tools = await discoverToolsFromOpenApi({ openapiUrl: "http://example.com/openapi.json" });

    expect(tools.map((t) => t.name)).toEqual(["ping-op"]);
  });
});

// ---------------------------------------------------------------------------
// L74:9-74:33 ConditionalExpression true (`err instanceof TypeError` forced
// always-true) and L75:95-75:109 ObjectLiteral {} (the `{ cause: err }`
// options object on the thrown OPENAPI_CYCLIC_REFERENCE Error, emptied).
//
// Case (a): a GENUINE circular reference produced by a real YAML
// anchor/alias (not a hand-patched JSON.parse) must be rejected with
// OPENAPI_CYCLIC_REFERENCE, and the thrown error's `.cause` must be the
// original TypeError — this kills the ObjectLiteral mutant (an emptied
// `{}` would leave `.cause` undefined).
// ---------------------------------------------------------------------------

describe("discoverToolsFromOpenApi — a genuine YAML-anchor cycle is rejected with cause preserved", () => {
  test("a real self-referential YAML alias throws OPENAPI_CYCLIC_REFERENCE with cause set to the original TypeError", async () => {
    const cyclicYaml = [
      'openapi: "3.1.0"',
      "info:",
      "  title: Cyclic",
      "  version: 1.0.0",
      "paths: {}",
      "x-cyclic: &anchor",
      "  self: *anchor",
      "",
    ].join("\n");

    mockFetchRaw(cyclicYaml, { "content-type": "application/yaml" });

    const { discoverToolsFromOpenApi } = await import("../../discovery/openapi-discovery.js");

    let caught: unknown;
    try {
      await discoverToolsFromOpenApi({ openapiUrl: "http://example.com/openapi.yaml" });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/OPENAPI_CYCLIC_REFERENCE/i);
    expect((caught as Error).cause).toBeInstanceOf(TypeError);
  });
});

// ---------------------------------------------------------------------------
// Case (b): a reachable NON-TypeError error from JSON.stringify — a very
// deeply nested but genuinely ACYCLIC structure blows the (recursive)
// JSON.stringify's call stack with a RangeError, not a TypeError, before the
// iterative depth-cap BFS ever runs. Real code must re-throw this RangeError
// as-is (the `if (err instanceof TypeError)` guard is false, taking the
// `throw err;` branch at line 77); the L74 mutant (forced always-true) would
// incorrectly wrap it as an OPENAPI_CYCLIC_REFERENCE Error instead. This
// demonstrates the instanceof check is NOT unobservable/equivalent — a
// non-TypeError JSON.stringify failure is genuinely reachable through this
// function's public API.
// ---------------------------------------------------------------------------

describe("discoverToolsFromOpenApi — a deep-but-acyclic stringify stack overflow is not mislabeled as cyclic", () => {
  test("a RangeError from JSON.stringify's own recursion limit propagates unwrapped, not as OPENAPI_CYCLIC_REFERENCE", async () => {
    // Deep enough to blow JSON.stringify's native recursion (verified
    // empirically: ~50000 levels reliably throws "Maximum call stack size
    // exceeded" in this Bun runtime), built via string concatenation (not
    // JSON.stringify, which would itself blow the stack while constructing
    // the fixture) so JSON.parse (which tolerates far deeper nesting than
    // JSON.stringify here) can still parse it back into a real object graph.
    const DEPTH = 60000;
    const text = '{"a":'.repeat(DEPTH) + "true" + "}".repeat(DEPTH);

    mockFetchRaw(text, { "content-type": "application/json" });

    const { discoverToolsFromOpenApi } = await import("../../discovery/openapi-discovery.js");

    let caught: unknown;
    try {
      await discoverToolsFromOpenApi({ openapiUrl: "http://example.com/openapi.json" });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(RangeError);
    expect((caught as Error).message).not.toMatch(/OPENAPI_CYCLIC_REFERENCE/i);
  });
});

// ---------------------------------------------------------------------------
// L88:11-88:25 ConditionalExpression false (`if (seen.has(node)) continue;`
// forced false — the BFS already-visited guard).
//
// A shared (aliased-but-acyclic) sub-structure, reachable via two paths at
// DIFFERENT depths, is enqueued twice under the mutant but must only be
// *processed* once under real code. maxJsonDepth is capped at exactly the
// depth of the FIRST (shallow) occurrence's traversal ceiling: real code
// visits the shared node via the shallow path first, marks it seen, and the
// later (deep) duplicate is skipped via `continue` before its own
// (over-the-cap) depth is ever checked — so real code does not throw. The
// mutant disables that skip, reprocesses the node at the deep occurrence's
// depth, and incorrectly throws OPENAPI_TOO_DEEP.
//
// (Verified empirically against a hand-written re-implementation of both the
// real and mutated BFS loop against this exact fixture before relying on
// this reasoning: real -> no throw; mutant -> throws at depth 11 with cap 10.)
// ---------------------------------------------------------------------------

describe("discoverToolsFromOpenApi — a shared (non-cyclic) node visited via two paths is only processed once", () => {
  test("a YAML-aliased shared sub-structure reachable at two different depths does not trip the depth cap", async () => {
    const cap = 10;
    const origMax = config.maxJsonDepth;
    (config as Record<string, unknown>).maxJsonDepth = cap;

    // "x-shallow" (depth 1) is the anchor's own definition; "x-deep" walks
    // 9 levels down (depths 2..10) before referencing the SAME object via
    // alias at depth 11. Real code visits the shared node once, at depth 1
    // (via x-shallow, dequeued before any of x-deep's descendants since BFS
    // drains shallower levels first); the depth-11 duplicate occurrence is
    // skipped outright.
    const yamlDoc = [
      'openapi: "3.1.0"',
      "info:",
      "  title: shared",
      "  version: 1.0.0",
      "paths: {}",
      "x-shallow: &s",
      "  val: 1",
      "x-deep:",
      "  l1:",
      "    l2:",
      "      l3:",
      "        l4:",
      "          l5:",
      "            l6:",
      "              l7:",
      "                l8:",
      "                  l9:",
      "                    l10: *s",
      "",
    ].join("\n");

    mockFetchRaw(yamlDoc, { "content-type": "application/yaml" });

    try {
      const { discoverToolsFromOpenApi } = await import("../../discovery/openapi-discovery.js");
      let threwTooDeep = false;
      try {
        await discoverToolsFromOpenApi({ openapiUrl: "http://example.com/openapi.yaml" });
      } catch (err) {
        if (err instanceof Error && /OPENAPI_TOO_DEEP/i.test(err.message)) {
          threwTooDeep = true;
        }
      }
      expect(threwTooDeep).toBe(false);
    } finally {
      (config as Record<string, unknown>).maxJsonDepth = origMax;
    }
  });
});

// ---------------------------------------------------------------------------
// L95:13-95:27 ConditionalExpression true — the `child !== null` half of
// `if (child !== null && typeof child === "object")` forced always-true.
// Since `typeof null === "object"` in JS, this guard exists specifically to
// keep a literal `null` value from being pushed onto the BFS queue as a
// node. A spec containing an explicit `null` extension value must succeed
// normally under real code (null is skipped); under the mutant, `null`
// would be pushed and later dequeued, and `Object.values(null)` throws a
// TypeError, causing the whole call to reject instead of succeeding.
// ---------------------------------------------------------------------------

describe("discoverToolsFromOpenApi — an explicit null value in the doc does not crash the depth-cap BFS", () => {
  test("a null extension field succeeds normally, proving null is skipped rather than queued as a node", async () => {
    mockFetch({
      openapi: "3.0.0",
      info: { title: "t", version: "1.0.0" },
      paths: {
        "/ping": {
          get: {
            operationId: "ping-op",
            summary: "s",
            responses: { "200": { description: "ok" } },
            "x-null-ext": null,
          },
        },
      },
    });

    const { discoverToolsFromOpenApi } = await import("../../discovery/openapi-discovery.js");
    const tools = await discoverToolsFromOpenApi({ openapiUrl: "http://example.com/openapi.json" });

    expect(tools.map((t) => t.name)).toEqual(["ping-op"]);
  });
});
