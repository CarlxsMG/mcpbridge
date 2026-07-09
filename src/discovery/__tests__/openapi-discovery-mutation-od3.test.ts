/**
 * Stryker mutation-testing backstop for src/discovery/openapi-discovery.ts
 * (domain 6, cluster: operation loop guards + name/endpoint/description
 * mapping + generateToolName, lines 120-173).
 *
 * Baseline: 211 mutants, 108 killed, 103 survived (+1 timeout), 51.18%.
 * The existing suite (openapi-discovery.test.ts / -depth.test.ts /
 * -pin.test.ts) covers the happy path, DNS pinning, and the depth/cycle
 * guards, but never:
 *   - feeds a falsy pathItem, or a non-method pathItem key, through the
 *     paths loop (L121, L123),
 *   - feeds a non-object/null operation value through the operation loop
 *     (L124),
 *   - omits `tags` entirely under active includeTags filtering, or uses tags
 *     that only PARTIALLY overlap includeTags (L134-135),
 *   - uses a MULTI-character path param (e.g. "{petId}") to distinguish the
 *     endpoint-conversion regex's quantifier from a reduced/no-quantifier
 *     form (L146),
 *   - exercises the summary/description/"No description" fallback chain in
 *     all three of its distinct states (L149),
 *   - omits operationId entirely, which is the ONLY way generateToolName()
 *     is ever invoked (`opId ?? generateToolName(method, path)`) (L167-173).
 *
 * dereference() is real (not mocked) in every test below — each fixture is a
 * structurally valid (if deliberately unusual) OpenAPI 3.0 document.
 */
import { describe, test, expect, afterEach } from "bun:test";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function mockFetch(spec: unknown): void {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(spec), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

// ---------------------------------------------------------------------------
// L121:9-121:18 ConditionalExpression [Survived] false
// (`if (!pathItem) continue;` forced false). A null pathItem alongside a
// valid one: real code skips the null entry silently via Object.entries;
// the mutant would proceed to Object.entries(null) on the next line, which
// throws.
// ---------------------------------------------------------------------------

describe("discoverToolsFromOpenApi — falsy pathItem entry is skipped, not crashed on", () => {
  test("a null pathItem alongside a valid one does not throw and only the valid path's tool appears", async () => {
    mockFetch({
      openapi: "3.0.0",
      info: { title: "t", version: "1.0.0" },
      paths: {
        "/broken": null,
        "/ok": {
          get: { operationId: "ok-op", summary: "Ok operation", responses: { "200": { description: "ok" } } },
        },
      },
    });

    const { discoverToolsFromOpenApi } = await import("../../discovery/openapi-discovery.js");
    const tools = await discoverToolsFromOpenApi({ openapiUrl: "http://example.com/openapi.json" });

    expect(tools.map((t) => t.name)).toEqual(["ok-op"]);
  });
});

// ---------------------------------------------------------------------------
// L123:11-123:37 ConditionalExpression [Survived] false
// (`if (!VALID_METHODS.has(method)) continue;` forced false). A "parameters"
// key (a legitimate OpenAPI PathItem field, not an HTTP method) alongside a
// real "get" operation: real code skips "parameters"; the mutant would try
// to treat the parameters array as an operation object and emit a bogus
// extra tool.
// ---------------------------------------------------------------------------

describe("discoverToolsFromOpenApi — a non-method pathItem key (parameters) is skipped", () => {
  test("a 'parameters' key alongside a real 'get' operation does not produce a bogus tool", async () => {
    mockFetch({
      openapi: "3.0.0",
      info: { title: "t", version: "1.0.0" },
      paths: {
        "/mixed": {
          parameters: [{ name: "x", in: "query", schema: { type: "string" } }],
          get: { operationId: "mixed-op", summary: "s", responses: { "200": { description: "ok" } } },
        },
      },
    });

    const { discoverToolsFromOpenApi } = await import("../../discovery/openapi-discovery.js");
    const tools = await discoverToolsFromOpenApi({ openapiUrl: "http://example.com/openapi.json" });

    expect(tools.length).toBe(1);
    expect(tools[0].name).toBe("mixed-op");
    expect(tools[0].method).toBe("GET");
  });
});

// ---------------------------------------------------------------------------
// L124:11-124:62 and sub-ranges, LogicalOperator/ConditionalExpression
// [Survived] (`if (typeof operation !== "object" || operation === null)
// continue;`). Two cases isolate both halves of the guard: a non-object
// primitive (boolean) operation value, and a null operation value, each
// alongside a valid operation on a sibling path. Real code skips both
// silently; the mutant would fall through — for the null case, the very
// next line (`operation["x-internal"]`) throws a TypeError reading a
// property of null.
// ---------------------------------------------------------------------------

describe("discoverToolsFromOpenApi — a non-object/null operation value is skipped, not treated as an operation", () => {
  test("a boolean operation value under a valid method key does not produce a bogus tool", async () => {
    mockFetch({
      openapi: "3.0.0",
      info: { title: "t", version: "1.0.0" },
      paths: {
        "/weird-bool": { get: true },
        "/ok-bool": {
          get: { operationId: "ok-bool-op", summary: "s", responses: { "200": { description: "ok" } } },
        },
      },
    });

    const { discoverToolsFromOpenApi } = await import("../../discovery/openapi-discovery.js");
    const tools = await discoverToolsFromOpenApi({ openapiUrl: "http://example.com/openapi.json" });

    expect(tools.map((t) => t.name)).toEqual(["ok-bool-op"]);
  });

  test("a null operation value under a valid method key does not throw and is skipped", async () => {
    mockFetch({
      openapi: "3.0.0",
      info: { title: "t", version: "1.0.0" },
      paths: {
        "/weird-null": { get: null },
        "/ok-null": {
          get: { operationId: "ok-null-op", summary: "s", responses: { "200": { description: "ok" } } },
        },
      },
    });

    const { discoverToolsFromOpenApi } = await import("../../discovery/openapi-discovery.js");
    const tools = await discoverToolsFromOpenApi({ openapiUrl: "http://example.com/openapi.json" });

    expect(tools.map((t) => t.name)).toEqual(["ok-null-op"]);
  });
});

// ---------------------------------------------------------------------------
// L134:52-134:54 ArrayDeclaration [Survived] (`operation.tags ?? []`
// fallback emptied to `["Stryker was here"]`) and L135:14-135:65
// MethodExpression [Survived] (`opTags.some(...)` -> `opTags.every(...)`).
// One test, two operations, under active includeTags:
//   - "no-tags-op" has NO tags field at all. Real: `?? []` -> `[].some(...)`
//     is false -> excluded. If the ArrayDeclaration mutant is active, the
//     fallback becomes `["Stryker was here"]`, and since includeTags below
//     deliberately also contains the literal "Stryker was here", `.some`
//     would flip to true -> wrongly INCLUDED.
//   - "partial-op" has tags ["a", "b"], overlapping includeTags only via
//     "b". Real `.some` includes it (at least one tag matches); the
//     `.every` mutant would exclude it (not ALL of its tags are in
//     includeTags).
// ---------------------------------------------------------------------------

describe("discoverToolsFromOpenApi — tags fallback + some-vs-every under includeTags", () => {
  test("an operation missing tags is excluded, and partial tag overlap still includes via .some", async () => {
    mockFetch({
      openapi: "3.0.0",
      info: { title: "t", version: "1.0.0" },
      paths: {
        "/no-tags": {
          get: { operationId: "no-tags-op", summary: "s", responses: { "200": { description: "ok" } } },
        },
        "/partial": {
          get: {
            operationId: "partial-op",
            summary: "s",
            tags: ["a", "b"],
            responses: { "200": { description: "ok" } },
          },
        },
      },
    });

    const { discoverToolsFromOpenApi } = await import("../../discovery/openapi-discovery.js");
    const tools = await discoverToolsFromOpenApi({
      openapiUrl: "http://example.com/openapi.json",
      includeTags: ["b", "c", "Stryker was here"],
    });

    expect(tools.map((t) => t.name)).toEqual(["partial-op"]);
  });
});

// ---------------------------------------------------------------------------
// L146:48-146:62 Regex [Survived] x2 (`/\{([^}])\}/g` quantifier removed,
// and `/\{([}]+)\}/g` character-class negation removed) + L146:64-146:69
// StringLiteral [Survived] (`":$1"` replacement emptied). A MULTI-character
// param name ("petId") is required: a quantifier-reduced regex requiring
// exactly one non-"}" character can't match "{petId}" at all (leaving the
// braces in place); a char-class-negated regex looking for "}" characters
// inside the braces also can't match (there are none). Both leave the
// endpoint un-converted; the emptied replacement literal instead drops the
// param name entirely. An exact toBe distinguishes all three from the real
// "/pets/:petId".
// ---------------------------------------------------------------------------

describe("discoverToolsFromOpenApi — endpoint {param} to :param conversion (multi-char param)", () => {
  test("a multi-character path param is converted to an Express-style :param", async () => {
    mockFetch({
      openapi: "3.0.0",
      info: { title: "t", version: "1.0.0" },
      paths: {
        "/pets/{petId}": {
          get: { operationId: "get-pet", summary: "Get a pet", responses: { "200": { description: "ok" } } },
        },
      },
    });

    const { discoverToolsFromOpenApi } = await import("../../discovery/openapi-discovery.js");
    const tools = await discoverToolsFromOpenApi({ openapiUrl: "http://example.com/openapi.json" });

    expect(tools[0].endpoint).toBe("/pets/:petId");
  });
});

// ---------------------------------------------------------------------------
// L149:27-149:89 / L149:27-149:69 LogicalOperator/ConditionalExpression
// [Survived] + L149:73-149:89 StringLiteral [Survived] (all on
// `operation.summary || operation.description || "No description"`). Three
// operations isolate every branch: summary-only, description-only, and
// neither. Any `||`->`&&` swap on either operator, or an emptied "No
// description" literal, changes at least one of these three expected values.
// ---------------------------------------------------------------------------

describe("discoverToolsFromOpenApi — summary/description/'No description' fallback", () => {
  test("summary-only, description-only, and neither all resolve to the correct description", async () => {
    mockFetch({
      openapi: "3.0.0",
      info: { title: "t", version: "1.0.0" },
      paths: {
        "/only-summary": {
          get: { operationId: "sum-op", summary: "Summary text", responses: { "200": { description: "ok" } } },
        },
        "/only-desc": {
          get: { operationId: "desc-op", description: "Desc text", responses: { "200": { description: "ok" } } },
        },
        "/neither": {
          get: { operationId: "neither-op", responses: { "200": { description: "ok" } } },
        },
      },
    });

    const { discoverToolsFromOpenApi } = await import("../../discovery/openapi-discovery.js");
    const tools = await discoverToolsFromOpenApi({ openapiUrl: "http://example.com/openapi.json" });

    const byName = Object.fromEntries(tools.map((t) => [t.name, t.description]));
    expect(byName["sum-op"]).toBe("Summary text");
    expect(byName["desc-op"]).toBe("Desc text");
    expect(byName["neither-op"]).toBe("No description");
  });
});

// ---------------------------------------------------------------------------
// L167:65-173:2 BlockStatement [Survived] (generateToolName's whole body
// emptied) + L168:20-171:21 MethodExpression [Survived] (the
// .replace().split().filter() chain reduced) + L169:14-169:28 Regex
// [Survived] x2 + L169:30-169:37 StringLiteral [Survived] ("by_$1" emptied)
// + L170:12-170:15 StringLiteral [Survived] ("/" split separator emptied)
// + L172:10-172:57 / L172:10-172:43 / L172:37-172:40 MethodExpression /
// StringLiteral [Survived] (the final template-literal + join + toLowerCase
// line). generateToolName is called ONLY when an operation has no
// operationId at all — no existing test ever omits operationId, so this
// whole function was completely untested. An exact toBe on the produced
// tool name (not a substring check) is needed since several of these
// mutants only diverge in small ways.
// ---------------------------------------------------------------------------

describe("discoverToolsFromOpenApi — generateToolName is exercised via a missing operationId", () => {
  test("a get operation with no operationId on a param path produces the exact generated name", async () => {
    mockFetch({
      openapi: "3.0.0",
      info: { title: "t", version: "1.0.0" },
      paths: {
        "/pets/{id}": {
          get: { summary: "Get a pet by id", responses: { "200": { description: "ok" } } },
        },
      },
    });

    const { discoverToolsFromOpenApi } = await import("../../discovery/openapi-discovery.js");
    const tools = await discoverToolsFromOpenApi({ openapiUrl: "http://example.com/openapi.json" });

    expect(tools.length).toBe(1);
    expect(tools[0].name).toBe("get_pets_by_id");
  });
});
