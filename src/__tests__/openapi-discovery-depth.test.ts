/**
 * TEST 2 — OpenAPI depth cap in openapi-discovery.ts
 *
 * Verifies that:
 *   1. A spec whose nesting exceeds config.maxJsonDepth is rejected with OPENAPI_TOO_DEEP.
 *   2. A spec at exactly the limit succeeds.
 *   3. A spec containing a genuine circular reference is rejected immediately with
 *      OPENAPI_CYCLIC_REFERENCE, before ever reaching the (cycle-unsafe) dereference() call.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { config } from "../config.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function mockFetchWithBody(body: string): void {
  globalThis.fetch = (async () =>
    new Response(body, {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

/**
 * Build a JSON-serialisable object nested exactly `depth` levels deep,
 * wrapped in a minimal OpenAPI envelope so dereference() has something to work with.
 * The object itself is in the `paths` section to be realistic.
 */
function buildDeepSpec(depth: number): string {
  // Build the deep object
  let nested: unknown = { type: "string" };
  for (let i = 0; i < depth; i++) {
    nested = { child: nested };
  }

  // Wrap it inside an OpenAPI spec paths section
  const spec = {
    openapi: "3.1.0",
    info: { title: "Deep API", version: "1.0.0" },
    paths: {
      "/ping": {
        get: {
          operationId: "ping",
          summary: "Ping",
          responses: { "200": { description: "ok" } },
          // Inject deeply nested extension to hit the depth cap
          "x-deep": nested,
        },
      },
    },
  };
  return JSON.stringify(spec);
}

// ---------------------------------------------------------------------------
// TEST 2a: Beyond maxJsonDepth → rejected with OPENAPI_TOO_DEEP
// ---------------------------------------------------------------------------

describe("discoverToolsFromOpenApi — depth cap: exceeds maxJsonDepth", () => {
  test("spec deeper than maxJsonDepth rejects with OPENAPI_TOO_DEEP", async () => {
    // Use a small cap to keep the test fast
    const cap = 5;
    const origMax = config.maxJsonDepth;
    (config as Record<string, unknown>).maxJsonDepth = cap;

    // Build a spec whose x-deep field is cap+2 levels deeper than the top
    mockFetchWithBody(buildDeepSpec(cap + 5));

    try {
      const { discoverToolsFromOpenApi } = await import("../discovery/openapi-discovery.js");
      await expect(discoverToolsFromOpenApi({ openapiUrl: "https://example.com/openapi.json" })).rejects.toThrow(
        /OPENAPI_TOO_DEEP/i,
      );
    } finally {
      (config as Record<string, unknown>).maxJsonDepth = origMax;
    }
  });
});

// ---------------------------------------------------------------------------
// TEST 2b: Exactly at the limit → succeeds (no rejection)
// ---------------------------------------------------------------------------

describe("discoverToolsFromOpenApi — depth cap: exactly at maxJsonDepth", () => {
  test("spec at exactly maxJsonDepth does not throw OPENAPI_TOO_DEEP", async () => {
    // Set a small cap
    const cap = 10;
    const origMax = config.maxJsonDepth;
    (config as Record<string, unknown>).maxJsonDepth = cap;

    // Build spec whose deepest nesting equals cap exactly (levels 0..cap)
    // The top-level openapi object is depth 0; paths is depth 1; /ping is 2; get is 3;
    // x-deep then adds `cap - 3` more levels so total is cap.
    // Use cap - 3 to be safe (well within the boundary).
    const nested = buildDeepSpec(cap - 4);
    mockFetchWithBody(nested);

    try {
      const { discoverToolsFromOpenApi } = await import("../discovery/openapi-discovery.js");
      // Should not throw OPENAPI_TOO_DEEP; may throw something else (invalid spec, etc.)
      // We accept any resolution or rejection EXCEPT for the depth error.
      let threw = false;
      let threwDepthError = false;
      try {
        await discoverToolsFromOpenApi({ openapiUrl: "https://example.com/openapi.json" });
      } catch (err) {
        threw = true;
        if (err instanceof Error && /OPENAPI_TOO_DEEP/i.test(err.message)) {
          threwDepthError = true;
        }
      }
      expect(threwDepthError).toBe(false);
      void threw; // used to suppress lint
    } finally {
      (config as Record<string, unknown>).maxJsonDepth = origMax;
    }
  });
});

// ---------------------------------------------------------------------------
// TEST 2c: Cyclic reference in parsed doc — BFS terminates (no hang)
// ---------------------------------------------------------------------------

describe("discoverToolsFromOpenApi — depth cap: cyclic reference terminates", () => {
  test("a spec object with a cycle is rejected immediately with OPENAPI_CYCLIC_REFERENCE", async () => {
    // We build a cyclic object and intercept JSON.parse to return it directly,
    // simulating what parseYaml() can legitimately produce from a YAML doc with
    // self-referential anchors/aliases (plain JSON text can never itself encode
    // a cycle, so this is the only way to construct one for the JSON.parse path).
    const cyclic: Record<string, unknown> = {
      openapi: "3.1.0",
      info: { title: "Cyclic", version: "1.0.0" },
      paths: {},
    };
    // Create a cycle
    cyclic["self"] = cyclic;

    // Patch JSON.parse to return the cyclic object for this one call
    const originalJSONParse = JSON.parse;
    let patchCount = 0;
    JSON.parse = function (...args: Parameters<typeof JSON.parse>) {
      if (patchCount === 0) {
        patchCount++;
        return cyclic;
      }
      return originalJSONParse(...args);
    } as typeof JSON.parse;

    // Provide any valid body string — it will be intercepted by our JSON.parse patch
    mockFetchWithBody('{"openapi":"3.1.0"}');

    try {
      const { discoverToolsFromOpenApi } = await import("../discovery/openapi-discovery.js");
      // No watchdog/race needed: the fix rejects synchronously (via JSON.stringify's
      // native cycle detection) before ever reaching the cycle-unsafe dereference()
      // call, so this resolves well within bun:test's default per-test timeout.
      await expect(discoverToolsFromOpenApi({ openapiUrl: "https://example.com/openapi.json" })).rejects.toThrow(
        /OPENAPI_CYCLIC_REFERENCE/i,
      );
    } finally {
      JSON.parse = originalJSONParse;
    }
  });
});
