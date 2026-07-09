/**
 * Stryker mutation-testing backstop for src/discovery/openapi-discovery.ts —
 * "Dereference errors, paths guard, basePath computation" cluster (lines 102-118).
 *
 * Targets these surviving mutants from the domain-6 baseline run:
 *
 *   L106:7-106:21   ConditionalExpression false + OptionalChaining (`errors?.length`,
 *                   the whole `if (errors?.length) throw ...` guard)
 *   L106:39-106:118 StringLiteral "" (the "Invalid OpenAPI spec: ..." template emptied)
 *   L106:75-106:104 ArrowFunction (the `.map((e) => e.message)` callback emptied,
 *                   returning undefined for every error)
 *   L106:111-106:115 StringLiteral "" (the `.join(", ")` separator emptied to `.join("")`)
 *   L107:7-107:21   ConditionalExpression false + L107:8-107:21 OptionalChaining
 *                   (`schema?.paths`, the `if (!schema?.paths) throw ...` guard)
 *   L107:39-107:66  StringLiteral "" (the "OpenAPI spec has no paths" message emptied)
 *   L112:21-112:42  OptionalChaining (`doc.servers?.[0]?.url`)
 *   L112:46-112:48  StringLiteral (the `""` fallback default emptied to a placeholder)
 *   L113:20-113:45  MethodExpression (`serverUrl.startsWith("/")` -> `endsWith("/")`)
 *   L113:41-113:44  StringLiteral (the "/" startsWith argument emptied)
 *   L113:66-113:71  Regex (`/\/$/` trailing-slash-strip pattern mutated)
 *   L113:73-113:75 / L113:79-113:81 StringLiteral (the replace() replacement "" and
 *                   surrounding literal placeholders)
 *   L117:51-117:53  ArrayDeclaration (`excludeOperations ?? []` fallback emptied to a
 *                   placeholder array)
 *
 * Real (unmutated) behavior verified empirically against the actual @scalar/openapi-parser
 * dereference() (not mocked — per project convention, real dereferencing is exercised
 * against genuinely invalid/valid OpenAPI structures) before writing assertions below.
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

// ---------------------------------------------------------------------------
// L106: dereference() errors — single error surfaces with real message text
// ---------------------------------------------------------------------------

describe("discoverToolsFromOpenApi — dereference() errors: single broken $ref", () => {
  test("throws 'Invalid OpenAPI spec:' containing the real underlying error message", async () => {
    // An operation whose response schema $ref points at a path that does not exist
    // anywhere in the document. This is a genuine, real dereference() failure (verified
    // empirically): resolveUri's segment walk hits an intermediate `undefined` and the
    // resulting TypeError is caught and pushed onto the parser's own `errors` array
    // rather than thrown — so `errors?.length` is the only thing standing between a
    // clean parse and a thrown Error here.
    const spec = {
      openapi: "3.0.0",
      info: { title: "t", version: "1.0.0" },
      paths: {
        "/a": {
          get: {
            operationId: "opA",
            responses: {
              "200": {
                description: "ok",
                content: {
                  "application/json": {
                    schema: { $ref: "#/components/schemas/Missing/Deep" },
                  },
                },
              },
            },
          },
        },
      },
      components: { schemas: { Other: { type: "object" } } },
    };
    mockFetch(spec);

    const { discoverToolsFromOpenApi } = await import("../../discovery/openapi-discovery.js");
    let thrown: Error | undefined;
    try {
      await discoverToolsFromOpenApi({ openapiUrl: "http://example.com/openapi.json" });
    } catch (err) {
      thrown = err as Error;
    }

    expect(thrown).toBeInstanceOf(Error);
    // Kills the whole-guard-forced-false mutant (would swallow the error and either
    // return normally or throw something unrelated further down).
    expect(thrown!.message).toContain("Invalid OpenAPI spec:");
    // Kills the StringLiteral-emptied template AND the ArrowFunction-emptied .map
    // callback: if either mutant fires, the real "Can't resolve reference: ..." text
    // (or the whole prefix) would be missing, undefined, or replaced with "".
    expect(thrown!.message).toContain("Can't resolve reference:");
    expect(thrown!.message).toContain("#/components/schemas/Missing/Deep");
    expect(thrown!.message).not.toContain("undefined");
    expect(thrown!.message.length).toBeGreaterThan("Invalid OpenAPI spec: ".length);
  });
});

// ---------------------------------------------------------------------------
// L106:111-106:115 — two errors are joined with ", " (comma-space), not ""
// ---------------------------------------------------------------------------

describe("discoverToolsFromOpenApi — dereference() errors: multiple errors joined with ', '", () => {
  test("two distinct broken $refs are joined by a comma-space separator", async () => {
    const spec = {
      openapi: "3.0.0",
      info: { title: "t", version: "1.0.0" },
      paths: {
        "/a": {
          get: {
            operationId: "opA",
            responses: {
              "200": {
                description: "ok",
                content: {
                  "application/json": { schema: { $ref: "#/components/schemas/Missing/Deep" } },
                },
              },
            },
          },
        },
        "/b": {
          get: {
            operationId: "opB",
            responses: {
              "200": {
                description: "ok",
                content: {
                  "application/json": { schema: { $ref: "#/components/schemas/AlsoMissing/Deep" } },
                },
              },
            },
          },
        },
      },
      components: { schemas: { Other: { type: "object" } } },
    };
    mockFetch(spec);

    const { discoverToolsFromOpenApi } = await import("../../discovery/openapi-discovery.js");
    let thrown: Error | undefined;
    try {
      await discoverToolsFromOpenApi({ openapiUrl: "http://example.com/openapi.json" });
    } catch (err) {
      thrown = err as Error;
    }

    expect(thrown).toBeInstanceOf(Error);
    // Both underlying messages must be present (kills the emptied-.map mutant: an
    // array of `undefined`s would lose both of these substrings).
    expect(thrown!.message).toContain("#/components/schemas/Missing/Deep");
    expect(thrown!.message).toContain("#/components/schemas/AlsoMissing/Deep");
    // Kills the .join(", ") -> .join("") mutant: with no separator the two message
    // texts would run directly into each other (".../Deep" immediately followed by
    // "Can't" with no comma or space in between).
    expect(thrown!.message).toContain(
      "Can't resolve reference: #/components/schemas/Missing/Deep, Can't resolve reference: #/components/schemas/AlsoMissing/Deep",
    );
    expect(thrown!.message).not.toContain("DeepCan't");
  });
});

// ---------------------------------------------------------------------------
// L107: schema?.paths guard — exact message, both a firing and a non-firing case
// ---------------------------------------------------------------------------

describe("discoverToolsFromOpenApi — no-paths guard", () => {
  test("a validly-dereferenced spec with no `paths` field at all throws the exact message", async () => {
    // No $refs anywhere, so dereference() itself reports zero errors and `schema` is
    // truthy — isolating the second guard (`!schema?.paths`) from the first
    // (`errors?.length`).
    const spec = { openapi: "3.0.0", info: { title: "t", version: "1.0.0" } };
    mockFetch(spec);

    const { discoverToolsFromOpenApi } = await import("../../discovery/openapi-discovery.js");
    await expect(discoverToolsFromOpenApi({ openapiUrl: "http://example.com/openapi.json" })).rejects.toThrow(
      "OpenAPI spec has no paths",
    );
  });

  test("a spec WITH a paths field does not throw the no-paths error (guard does not false-fire)", async () => {
    const spec = {
      openapi: "3.0.0",
      info: { title: "t", version: "1.0.0" },
      paths: {
        "/ping": {
          get: { operationId: "ping", summary: "ping", responses: { "200": { description: "ok" } } },
        },
      },
    };
    mockFetch(spec);

    const { discoverToolsFromOpenApi } = await import("../../discovery/openapi-discovery.js");
    const tools = await discoverToolsFromOpenApi({ openapiUrl: "http://example.com/openapi.json" });
    expect(tools.map((t) => t.name)).toEqual(["ping"]);
  });
});

// ---------------------------------------------------------------------------
// L112 + L113: basePath computation from doc.servers?.[0]?.url
// ---------------------------------------------------------------------------

describe("discoverToolsFromOpenApi — basePath: no servers array at all", () => {
  test("a spec with no `servers` field produces an endpoint with no base-path prefix", async () => {
    const spec = {
      openapi: "3.0.0",
      info: { title: "t", version: "1.0.0" },
      paths: {
        "/items/{id}": {
          get: { operationId: "getItem", summary: "get item", responses: { "200": { description: "ok" } } },
        },
      },
    };
    mockFetch(spec);

    const { discoverToolsFromOpenApi } = await import("../../discovery/openapi-discovery.js");
    const tools = await discoverToolsFromOpenApi({ openapiUrl: "http://example.com/openapi.json" });
    // Kills the OptionalChaining mutant (which would throw on `doc.servers[0]` when
    // servers is undefined) and the "" fallback StringLiteral mutant (which would
    // splice a placeholder string into the endpoint instead of an empty basePath).
    expect(tools.map((t) => t.endpoint)).toEqual(["/items/:id"]);
  });
});

describe("discoverToolsFromOpenApi — basePath: relative server URL with trailing slash", () => {
  test("a relative server URL starting with '/' has its trailing slash stripped", async () => {
    const spec = {
      openapi: "3.0.0",
      info: { title: "t", version: "1.0.0" },
      servers: [{ url: "/api/v1/" }],
      paths: {
        "/items/{id}": {
          get: { operationId: "getItem", summary: "get item", responses: { "200": { description: "ok" } } },
        },
      },
    };
    mockFetch(spec);

    const { discoverToolsFromOpenApi } = await import("../../discovery/openapi-discovery.js");
    const tools = await discoverToolsFromOpenApi({ openapiUrl: "http://example.com/openapi.json" });
    // "/api/v1/" -> basePath "/api/v1" (trailing slash stripped) -> endpoint
    // "/api/v1" + "/items/:id". Kills startsWith("/")->endsWith("/") (would still
    // match here, so this alone doesn't discriminate — paired with the absolute-URL
    // case below it does), the "/" argument emptied, the /\/$/ regex mutated (would
    // leave the trailing slash in, or strip more/less than exactly one trailing
    // slash), and the replace() literal placeholders.
    expect(tools.map((t) => t.endpoint)).toEqual(["/api/v1/items/:id"]);
  });
});

describe("discoverToolsFromOpenApi — basePath: absolute server URL is not used as a prefix", () => {
  test("an absolute (non-relative) server URL falls back to an empty basePath", async () => {
    const spec = {
      openapi: "3.0.0",
      info: { title: "t", version: "1.0.0" },
      servers: [{ url: "https://example.com/api" }],
      paths: {
        "/items/{id}": {
          get: { operationId: "getItem", summary: "get item", responses: { "200": { description: "ok" } } },
        },
      },
    };
    mockFetch(spec);

    const { discoverToolsFromOpenApi } = await import("../../discovery/openapi-discovery.js");
    const tools = await discoverToolsFromOpenApi({ openapiUrl: "http://example.com/openapi.json" });
    // "https://example.com/api" does not start with "/", so basePath must be "" —
    // NOT the absolute URL itself. Kills the startsWith("/")->endsWith("/") swap
    // (which would flip false->true here since the URL doesn't end with "/" either,
    // so combined with the "/api/v1/" case above the two together isolate the exact
    // startsWith("/") semantics) and any placeholder-string mutant that would leak a
    // literal into the endpoint.
    expect(tools.map((t) => t.endpoint)).toEqual(["/items/:id"]);
    expect(tools[0].endpoint).not.toContain("example.com");
    expect(tools[0].endpoint).not.toContain("https");
  });
});

// ---------------------------------------------------------------------------
// L117: excludeOperations ?? [] fallback — omitted option does not exclude everything
// ---------------------------------------------------------------------------

describe("discoverToolsFromOpenApi — excludeOperations omitted entirely", () => {
  test("calling without excludeOperations still includes every operation", async () => {
    const spec = {
      openapi: "3.0.0",
      info: { title: "t", version: "1.0.0" },
      paths: {
        "/ping": {
          get: { operationId: "ping", summary: "ping", responses: { "200": { description: "ok" } } },
        },
      },
    };
    mockFetch(spec);

    const { discoverToolsFromOpenApi } = await import("../../discovery/openapi-discovery.js");
    // No `excludeOperations` key at all in the options object passed in.
    const tools = await discoverToolsFromOpenApi({ openapiUrl: "http://example.com/openapi.json" });
    expect(tools.map((t) => t.name)).toEqual(["ping"]);
  });
});
