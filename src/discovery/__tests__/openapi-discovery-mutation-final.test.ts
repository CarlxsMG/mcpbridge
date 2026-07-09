/**
 * Stryker mutation-testing backstop for src/discovery/openapi-discovery.ts —
 * manual closing pass after the 5-agent cold round (od1-od5), closing the
 * remaining real gaps and documenting genuine equivalents for the rest.
 *
 * Targets these surviving mutants from the post-cold-round verify run:
 *
 *   L112:21-112:42  OptionalChaining (`doc.servers?.[0]?.url` -> `doc.servers?.[0].url`,
 *                   dropping the SECOND `?.` specifically). od2's "no servers field at
 *                   all" test never reaches this link (the FIRST `?.` short-circuits
 *                   before `[0]` is ever indexed) — needs `servers: []` (present but
 *                   empty) to actually reach `[0]` and observe the missing second guard.
 *   L113:20-113:45  MethodExpression (`serverUrl.startsWith("/")` -> `endsWith("/")`).
 *                   od2's two test cases ("/api/v1/" and "https://example.com/api")
 *                   BOTH coincidentally produce identical results under startsWith vs
 *                   endsWith (verified empirically) — a relative path WITHOUT a
 *                   trailing slash is required to actually discriminate them.
 *   L117:51-117:53  ArrayDeclaration (`excludeOperations ?? []` -> `?? ["Stryker was
 *                   here"]`). od2's "omitted entirely" test can't distinguish an empty
 *                   fallback set from one containing a string no real operationId will
 *                   ever match — needs an operation whose operationId IS LITERALLY
 *                   Stryker's own placeholder text.
 *   L168:20-171:21  MethodExpression (generateToolName's `.filter(Boolean)` dropped
 *                   from the `.replace().split().filter()` chain). Reachable only when
 *                   an operation has no `operationId` (falls back to generateToolName),
 *                   whose result ALWAYS then passes through sanitizeToolName — which
 *                   itself collapses repeated underscores, masking most leading/interior
 *                   empty-segment artifacts the missing filter would introduce. Verified
 *                   empirically that a TRAILING slash in the path is the one case that
 *                   survives this masking (sanitizeToolName only strips LEADING invalid
 *                   characters, never trailing ones).
 *
 * Documented equivalents (verified empirically before accepting, not assumed):
 *
 *   L106:7-106:21 OptionalChaining ('errors.length') and L107:8-107:21 OptionalChaining
 *   ('schema.paths') — @scalar/openapi-parser's dereference() ALWAYS returns `errors` as
 *   a real array (confirmed via a direct call: `errors: []` on a clean spec, never
 *   `undefined`), and `schema` is always a truthy object on any path this code reaches
 *   (verified for both the happy path and the "no paths" edge case od2 already tests).
 *   Since the guarded value is never actually null/undefined for any input reachable
 *   through the public API, the `?.` is purely defensive and its removal is
 *   unobservable.
 *
 *   L112:46-112:48 StringLiteral (the `?? ""` fallback text, mutated to
 *   "Stryker was here!"). The ONLY consumer of this fallback value is
 *   `serverUrl.startsWith("/")` two lines later — and Stryker's placeholder text does
 *   NOT start with "/", so it evaluates `startsWith("/")` to `false` identically to the
 *   real `""` fallback. Verified empirically: both produce basePath = "" for any input
 *   that reaches this fallback at all, since the fallback value's ONLY use is that one
 *   startsWith check, which any non-"/"-prefixed string fails identically.
 *
 *   L172:10-172:57 MethodExpression (generateToolName's own `.toLowerCase()` ->
 *   `.toUpperCase()`). generateToolName's result is ALWAYS immediately passed through
 *   `sanitizeToolName` at the only call site (`opId ?? generateToolName(...)`), which
 *   itself unconditionally lowercases its input as its own second pipeline step —
 *   completely masking whatever case generateToolName itself produced. Verified
 *   empirically: both the real (toLowerCase) and mutant (toUpperCase) versions produce
 *   the identical final sanitized name.
 *
 *   L190:9-190:24 ConditionalExpression false + L190:9-190:15 StringLiteral (the
 *   `"$ref" in param` guard) — already investigated and documented as equivalent by the
 *   od4 agent (dereference() never leaves an unresolved `$ref` on a parameter object
 *   reachable through the public API); confirmed consistent with this file's own
 *   od4/od5 findings and not re-litigated here.
 */
import { describe, test, expect, afterEach } from "bun:test";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function mockFetch(bodyObjOrString: unknown): void {
  const body = typeof bodyObjOrString === "string" ? bodyObjOrString : JSON.stringify(bodyObjOrString);
  globalThis.fetch = (async () =>
    new Response(body, {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

describe("discoverToolsFromOpenApi — basePath: an empty (but present) servers array", () => {
  test("servers: [] does not throw and produces no base-path prefix", async () => {
    const spec = {
      openapi: "3.0.0",
      info: { title: "t", version: "1.0.0" },
      servers: [],
      paths: {
        "/items/{id}": {
          get: { operationId: "getItem", summary: "get item", responses: { "200": { description: "ok" } } },
        },
      },
    };
    mockFetch(spec);

    const { discoverToolsFromOpenApi } = await import("../../discovery/openapi-discovery.js");
    const tools = await discoverToolsFromOpenApi({ openapiUrl: "http://example.com/openapi.json" });
    expect(tools.map((t) => t.endpoint)).toEqual(["/items/:id"]);
  });
});

describe("discoverToolsFromOpenApi — basePath: relative server URL WITHOUT a trailing slash", () => {
  test("'/api/v1' (no trailing slash) is used as-is, discriminating startsWith from endsWith", async () => {
    const spec = {
      openapi: "3.0.0",
      info: { title: "t", version: "1.0.0" },
      servers: [{ url: "/api/v1" }],
      paths: {
        "/items/{id}": {
          get: { operationId: "getItem", summary: "get item", responses: { "200": { description: "ok" } } },
        },
      },
    };
    mockFetch(spec);

    const { discoverToolsFromOpenApi } = await import("../../discovery/openapi-discovery.js");
    const tools = await discoverToolsFromOpenApi({ openapiUrl: "http://example.com/openapi.json" });
    // Real (startsWith): true -> basePath "/api/v1". Mutant (endsWith): false (doesn't
    // end in "/") -> basePath "" -> endpoint would be "/items/:id" with no prefix.
    expect(tools.map((t) => t.endpoint)).toEqual(["/api/v1/items/:id"]);
  });
});

describe("discoverToolsFromOpenApi — excludeOperations omitted, operationId matches Stryker's own placeholder", () => {
  test("an operationId literally 'Stryker was here' is still included when excludeOperations is omitted", async () => {
    const spec = {
      openapi: "3.0.0",
      info: { title: "t", version: "1.0.0" },
      paths: {
        "/x": {
          get: {
            operationId: "Stryker was here",
            summary: "x",
            responses: { "200": { description: "ok" } },
          },
        },
      },
    };
    mockFetch(spec);

    const { discoverToolsFromOpenApi } = await import("../../discovery/openapi-discovery.js");
    const tools = await discoverToolsFromOpenApi({ openapiUrl: "http://example.com/openapi.json" });
    expect(tools).toHaveLength(1);
  });
});

describe("generateToolName (via a missing operationId) — filters out empty path segments", () => {
  test("a trailing-slash path does not leave a stray trailing underscore in the generated name", async () => {
    // No operationId at all, forcing the fallback to generateToolName(method, path).
    // Its result always flows through sanitizeToolName next, which collapses repeated
    // underscores but only strips LEADING invalid characters — a TRAILING empty
    // segment (from a path ending in "/") is the one case sanitizeToolName can't mask.
    const spec = {
      openapi: "3.0.0",
      info: { title: "t", version: "1.0.0" },
      paths: {
        "/pets/": {
          get: { summary: "list pets", responses: { "200": { description: "ok" } } },
        },
      },
    };
    mockFetch(spec);

    const { discoverToolsFromOpenApi } = await import("../../discovery/openapi-discovery.js");
    const tools = await discoverToolsFromOpenApi({ openapiUrl: "http://example.com/openapi.json" });
    expect(tools).toHaveLength(1);
    // Real: "get_pets" (empty trailing segment filtered out before joining).
    // Mutant (no filter): "get___pets_" -> collapsed by sanitizeToolName's underscore
    // collapse to "get_pets_" (trailing underscore survives, since only LEADING
    // invalid characters are stripped).
    expect(tools[0].name).toBe("get_pets");
  });
});
