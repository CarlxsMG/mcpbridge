import { describe, test, expect, afterEach } from "bun:test";

// Regression for Finding #11: buildInputSchema previously read only
// bodySchemaObj.properties/.required, so a request body defined via allOf/oneOf/
// anyOf composition (which @scalar/openapi-parser dereferences $refs in but does
// NOT merge) yielded properties:{} — a silently unusable tool. flattenComposedSchema
// now merges composition members.

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

function specWithBody(schema: unknown): string {
  return JSON.stringify({
    openapi: "3.0.0",
    info: { title: "t", version: "1" },
    paths: {
      "/things": {
        post: {
          operationId: "createThing",
          requestBody: {
            content: { "application/json": { schema } },
          },
          responses: { "200": { description: "ok" } },
        },
      },
    },
  });
}

describe("buildInputSchema — allOf/oneOf/anyOf composition", () => {
  test("allOf-composed request body merges member properties and unions required", async () => {
    mockFetch(
      specWithBody({
        allOf: [
          { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
          { type: "object", properties: { name: { type: "string" }, age: { type: "integer" } }, required: ["name"] },
        ],
      }),
    );

    const { discoverToolsFromOpenApi } = await import("../../discovery/openapi-discovery.js");
    const tools = await discoverToolsFromOpenApi({ openapiUrl: "http://example.com/openapi.json" });
    expect(tools.length).toBe(1);

    const props = tools[0]!.inputSchema.properties as Record<string, unknown>;
    expect(Object.keys(props).sort()).toEqual(["age", "id", "name"]);

    const required = tools[0]!.inputSchema.required as string[];
    expect(required.sort()).toEqual(["id", "name"]);
  });

  test("oneOf-composed request body unions branch properties but marks none required", async () => {
    mockFetch(
      specWithBody({
        oneOf: [
          { type: "object", properties: { a: { type: "string" } }, required: ["a"] },
          { type: "object", properties: { b: { type: "string" } }, required: ["b"] },
        ],
      }),
    );

    const { discoverToolsFromOpenApi } = await import("../../discovery/openapi-discovery.js");
    const tools = await discoverToolsFromOpenApi({ openapiUrl: "http://example.com/openapi.json" });
    const props = tools[0]!.inputSchema.properties as Record<string, unknown>;
    expect(Object.keys(props).sort()).toEqual(["a", "b"]);
    // Neither branch's field is universally required.
    expect(tools[0]!.inputSchema.required).toBeUndefined();
  });

  test("nested allOf inside allOf flattens recursively", async () => {
    mockFetch(
      specWithBody({
        allOf: [
          { allOf: [{ type: "object", properties: { deep: { type: "string" } }, required: ["deep"] }] },
          { type: "object", properties: { top: { type: "string" } } },
        ],
      }),
    );

    const { discoverToolsFromOpenApi } = await import("../../discovery/openapi-discovery.js");
    const tools = await discoverToolsFromOpenApi({ openapiUrl: "http://example.com/openapi.json" });
    const props = tools[0]!.inputSchema.properties as Record<string, unknown>;
    expect(Object.keys(props).sort()).toEqual(["deep", "top"]);
    expect(tools[0]!.inputSchema.required as string[]).toEqual(["deep"]);
  });
});
