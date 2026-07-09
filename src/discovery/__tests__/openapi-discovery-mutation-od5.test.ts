/**
 * Stryker mutation-testing backstop for src/discovery/openapi-discovery.ts —
 * cluster: buildInputSchema's request-body handling + final return shape
 * (lines 204-228).
 *
 * Baseline: 211 mutants, 108 killed, 103 survived (+1 timeout), 51.18%.
 * This file targets the "buildInputSchema — request body + final return
 * shape" survivor cluster (L207-L226). `buildInputSchema` itself isn't
 * exported, so every case here goes through the public
 * `discoverToolsFromOpenApi()` entry point with a mocked `fetch`, exactly
 * like the existing openapi-discovery test files, and asserts on the
 * resulting `tools[0].inputSchema`.
 *
 * Two narrow sub-mutants are treated as equivalent rather than forced (see
 * the note above the "stray empty-string key" tests below): the isolated
 * BooleanLiteral-forced-`true` variants of `!("$ref" in requestBody)` and
 * `!("$ref" in bodySchema)` require an object that still carries a literal
 * "$ref" key by the time buildInputSchema sees it. Verified empirically
 * (via a standalone script against the real `dereference()` from
 * @scalar/openapi-parser) that dereferencing a spec with a requestBody-level
 * `$ref` or a schema-level `$ref` fully replaces the reference with the
 * resolved target object, leaving no "$ref" key behind in either case — so
 * that branch is unreachable through the public discovery API, matching the
 * pattern already called out in the source's own comment on the
 * parameter-level guard ("should not occur post-dereference, but guard
 * defensively").
 */
import { describe, test, expect, afterEach } from "bun:test";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function mockFetch(body: string): void {
  globalThis.fetch = (async () =>
    new Response(body, {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

// Narrow shape helper — inputSchema is typed as Record<string, unknown> on
// RestToolDefinition, so tests cast it to something we can assert against
// without `any`.
interface BuiltInputSchema {
  type: "object";
  properties: Record<string, Record<string, unknown>>;
  required?: string[];
}

// ---------------------------------------------------------------------------
// T1 — resolved requestBody + resolved body schema merge correctly, alongside
// parameter-derived required names.
//
// Kills:
//   L207:5-207:44 ConditionalExpression forced false, L207:20-207:44
//     BooleanLiteral forced false (`requestBody && !("$ref" in requestBody)`
//     — forcing either to false would make bodySchema always undefined, so
//     name/age would never appear).
//   L208:9-208:91 / L208:9-208:83 OptionalChaining, L208:64-208:82
//     StringLiteral ("application/json" emptied to "") — a wrong/emptied
//     media-type key would also make bodySchema undefined here since this
//     spec's content object only has the real "application/json" key.
//   L211:7-211:44 ConditionalExpression forced false, L211:21-211:44
//     BooleanLiteral forced false (`bodySchema && !("$ref" in bodySchema)`).
//   L211:46-221:4 / L213:35-217:6 / L214:74-216:8 BlockStatement (properties
//     merge emptied at any of the three nesting levels) — name AND age must
//     both survive with their own nested `type`, proving the for-loop body
//     itself ran, not just that the outer guard passed.
//   L213:9-213:33 ConditionalExpression forced false (`if
//     (bodySchemaObj.properties)`).
//   L218:9-218:46 ConditionalExpression forced false, L218:48-220:6
//     BlockStatement (the required-array push emptied) — body-derived
//     "name" must land in the FINAL required array, merged alongside the
//     path-param-derived "id".
//   L226:9-226:28 ConditionalExpression/EqualityOperator variants,
//     L226:31-226:43 ObjectLiteral — required.length > 0 here, so the
//     `required` key must be present with its exact merged content.
// ---------------------------------------------------------------------------

describe("buildInputSchema — resolved request body merges properties + required alongside params", () => {
  test("path-param-derived and body-derived properties/required both land in the final inputSchema", async () => {
    const spec = JSON.stringify({
      openapi: "3.0.0",
      info: { title: "T1", version: "1.0.0" },
      paths: {
        "/things/{id}": {
          post: {
            operationId: "update-thing",
            parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
            requestBody: {
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      name: { type: "string" },
                      age: { type: "number" },
                    },
                    required: ["name"],
                  },
                },
              },
            },
            responses: { "200": { description: "ok" } },
          },
        },
      },
    });
    mockFetch(spec);

    const { discoverToolsFromOpenApi } = await import("../../discovery/openapi-discovery.js");
    const tools = await discoverToolsFromOpenApi({ openapiUrl: "http://example.com/openapi.json" });

    expect(tools.length).toBe(1);
    const inputSchema = tools[0].inputSchema as unknown as BuiltInputSchema;

    // Every property, with its own nested `type`, proves the body schema's
    // properties were actually walked and merged (not just presence-checked).
    expect(inputSchema.properties).toEqual({
      id: { type: "string" },
      name: { type: "string" },
      age: { type: "number" },
    });

    // Path-param "id" (parameter-derived) and body-required "name"
    // (body-derived) must both be present, in that order.
    expect(Object.prototype.hasOwnProperty.call(inputSchema, "required")).toBe(true);
    expect(inputSchema.required).toEqual(["id", "name"]);
  });
});

// ---------------------------------------------------------------------------
// T2 — no requestBody at all on the operation.
//
// Kills:
//   L207:5-207:44 ConditionalExpression forced true (`requestBody && ...`
//     forced to always-true would evaluate `(undefined).content` and throw,
//     since requestBody is `undefined` here).
//   L226:9-226:28 ConditionalExpression/EqualityOperator forced true (there
//     are zero required fields at all — a forced-true `required` branch
//     would add a `required: []` key, which is present-but-empty rather
//     than genuinely absent; only a hasOwnProperty check distinguishes the
//     two).
// ---------------------------------------------------------------------------

describe("buildInputSchema — operation with no requestBody at all", () => {
  test("does not crash, does not add spurious properties, and omits `required` entirely", async () => {
    const spec = JSON.stringify({
      openapi: "3.0.0",
      info: { title: "T2", version: "1.0.0" },
      paths: {
        "/widgets": {
          get: {
            operationId: "get-widget",
            parameters: [{ name: "filter", in: "query", required: false, schema: { type: "string" } }],
            responses: { "200": { description: "ok" } },
          },
        },
      },
    });
    mockFetch(spec);

    const { discoverToolsFromOpenApi } = await import("../../discovery/openapi-discovery.js");
    const tools = await discoverToolsFromOpenApi({ openapiUrl: "http://example.com/openapi.json" });

    expect(tools.length).toBe(1);
    const inputSchema = tools[0].inputSchema as unknown as BuiltInputSchema;

    expect(inputSchema.properties).toEqual({ filter: { type: "string" } });
    // Zero required fields anywhere (no path param, no body) — the key
    // itself must be absent, not present-with-an-empty-array.
    expect(Object.prototype.hasOwnProperty.call(inputSchema, "required")).toBe(false);
    expect(Object.keys(inputSchema)).not.toContain("required");
  });
});

// ---------------------------------------------------------------------------
// T3 — requestBody is present but has no `content` field at all (legal per
// the OpenAPIV3.RequestBodyObject type — `content` isn't marked optional
// there, but nothing in buildInputSchema enforces that at runtime, and nothing
// upstream fabricates one either).
//
// Kills:
//   L208:9-208:91 OptionalChaining on `.content?.[...]` — removing this `?.`
//   would evaluate `undefined["application/json"]` and throw, since
//   `requestBody.content` is `undefined` here.
// ---------------------------------------------------------------------------

describe("buildInputSchema — requestBody present but missing `content`", () => {
  test("does not crash and adds no body-derived properties", async () => {
    const spec = JSON.stringify({
      openapi: "3.0.0",
      info: { title: "T3", version: "1.0.0" },
      paths: {
        "/no-content": {
          post: {
            operationId: "no-content-op",
            requestBody: { description: "a body with no content field" },
            responses: { "200": { description: "ok" } },
          },
        },
      },
    });
    mockFetch(spec);

    const { discoverToolsFromOpenApi } = await import("../../discovery/openapi-discovery.js");
    const tools = await discoverToolsFromOpenApi({ openapiUrl: "http://example.com/openapi.json" });

    expect(tools.length).toBe(1);
    const inputSchema = tools[0].inputSchema as unknown as BuiltInputSchema;
    expect(inputSchema.properties).toEqual({});
    expect(Object.prototype.hasOwnProperty.call(inputSchema, "required")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// T4 — requestBody's `content` object exists but only has a non-JSON media
// type (no "application/json" key at all).
//
// Kills:
//   L208:9-208:83 OptionalChaining on the `?.` guarding `.schema` — removing
//     it would evaluate `content["application/json"].schema`; since
//     `content["application/json"]` is `undefined` here (only
//     "application/xml" is present), that throws `.schema` on undefined.
//   Also demonstrates the exact-media-type-key requirement: the body's own
//   "secret" property must NOT be merged in when only application/xml is
//   offered, proving "application/json" isn't treated as "any key present".
// ---------------------------------------------------------------------------

describe("buildInputSchema — requestBody content has only a non-JSON media type", () => {
  test("does not crash and the non-JSON body's properties are not merged in", async () => {
    const spec = JSON.stringify({
      openapi: "3.0.0",
      info: { title: "T4", version: "1.0.0" },
      paths: {
        "/upload": {
          post: {
            operationId: "upload-thing",
            requestBody: {
              content: {
                "application/xml": {
                  schema: { type: "object", properties: { secret: { type: "string" } } },
                },
              },
            },
            responses: { "200": { description: "ok" } },
          },
        },
      },
    });
    mockFetch(spec);

    const { discoverToolsFromOpenApi } = await import("../../discovery/openapi-discovery.js");
    const tools = await discoverToolsFromOpenApi({ openapiUrl: "http://example.com/openapi.json" });

    expect(tools.length).toBe(1);
    const inputSchema = tools[0].inputSchema as unknown as BuiltInputSchema;
    expect(inputSchema.properties).toEqual({});
    expect(inputSchema.properties.secret).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(inputSchema, "required")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// T5 / T6 — a stray empty-string (`""`) own-key sitting alongside `content`
// on the requestBody object, and alongside `type`/`properties` on the body
// schema object itself, kills the StringLiteral mutants that empty the
// literal "$ref" string being checked for (L207:22-207:28 and
// L211:23-211:29). Real code checks the literal string "$ref"; neither
// object here has a "$ref" key, so real behavior resolves the body
// normally. A StringLiteral mutant checking `"" in requestBody` (or `"" in
// bodySchema`) instead would find the stray "" key IS present, flip the
// negated check to false, and skip the merge entirely — which the
// assertions below would catch. (Verified empirically that dereference()
// preserves unrecognized own keys like "" through to the final schema —
// it's schema-agnostic $ref resolution, not OpenAPI validation.)
// ---------------------------------------------------------------------------

describe("buildInputSchema — stray empty-string key on requestBody is not mistaken for $ref", () => {
  test('a requestBody with an extra "" key still resolves its JSON body schema', async () => {
    const spec = JSON.stringify({
      openapi: "3.0.0",
      info: { title: "T5", version: "1.0.0" },
      paths: {
        "/things": {
          post: {
            operationId: "create-thing",
            requestBody: {
              "": "stray-key",
              content: {
                "application/json": {
                  schema: { type: "object", properties: { name: { type: "string" } } },
                },
              },
            },
            responses: { "200": { description: "ok" } },
          },
        },
      },
    });
    mockFetch(spec);

    const { discoverToolsFromOpenApi } = await import("../../discovery/openapi-discovery.js");
    const tools = await discoverToolsFromOpenApi({ openapiUrl: "http://example.com/openapi.json" });

    expect(tools.length).toBe(1);
    const inputSchema = tools[0].inputSchema as unknown as BuiltInputSchema;
    expect(inputSchema.properties).toEqual({ name: { type: "string" } });
  });
});

describe("buildInputSchema — stray empty-string key on the body schema itself is not mistaken for $ref", () => {
  test('a body schema with an extra "" key still merges its properties and required', async () => {
    const spec = JSON.stringify({
      openapi: "3.0.0",
      info: { title: "T6", version: "1.0.0" },
      paths: {
        "/things2": {
          post: {
            operationId: "create-thing2",
            requestBody: {
              content: {
                "application/json": {
                  schema: {
                    "": "stray-key",
                    type: "object",
                    properties: { name: { type: "string" } },
                    required: ["name"],
                  },
                },
              },
            },
            responses: { "200": { description: "ok" } },
          },
        },
      },
    });
    mockFetch(spec);

    const { discoverToolsFromOpenApi } = await import("../../discovery/openapi-discovery.js");
    const tools = await discoverToolsFromOpenApi({ openapiUrl: "http://example.com/openapi.json" });

    expect(tools.length).toBe(1);
    const inputSchema = tools[0].inputSchema as unknown as BuiltInputSchema;
    expect(inputSchema.properties).toEqual({ name: { type: "string" } });
    expect(inputSchema.required).toEqual(["name"]);
  });
});

// ---------------------------------------------------------------------------
// T7 — a resolved body schema with NEITHER `properties` nor `required`.
//
// Kills:
//   L213:9-213:33 ConditionalExpression forced true (`if
//     (bodySchemaObj.properties)`) — forcing true when properties is
//     actually undefined would evaluate `Object.entries(undefined)` and
//     throw.
//   L218:9-218:46 ConditionalExpression forced true (`if
//     (Array.isArray(bodySchemaObj.required))`) — forcing true when
//     required is actually undefined would spread `...undefined` into
//     `required.push(...)` and throw.
// ---------------------------------------------------------------------------

describe("buildInputSchema — body schema with neither properties nor required", () => {
  test("does not crash and adds no spurious properties or required entries", async () => {
    const spec = JSON.stringify({
      openapi: "3.0.0",
      info: { title: "T7", version: "1.0.0" },
      paths: {
        "/ping-thing": {
          post: {
            operationId: "ping-thing",
            requestBody: {
              content: {
                "application/json": {
                  schema: { type: "object" },
                },
              },
            },
            responses: { "200": { description: "ok" } },
          },
        },
      },
    });
    mockFetch(spec);

    const { discoverToolsFromOpenApi } = await import("../../discovery/openapi-discovery.js");
    const tools = await discoverToolsFromOpenApi({ openapiUrl: "http://example.com/openapi.json" });

    expect(tools.length).toBe(1);
    const inputSchema = tools[0].inputSchema as unknown as BuiltInputSchema;
    expect(inputSchema.properties).toEqual({});
    expect(Object.prototype.hasOwnProperty.call(inputSchema, "required")).toBe(false);
  });
});
