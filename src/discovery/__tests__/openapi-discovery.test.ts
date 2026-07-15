import { describe, test, expect, afterEach } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

// Fixture paths
const FIXTURES_DIR = join(import.meta.dir, "../../../tests/fixtures");
const SIMPLE_JSON_SPEC = readFileSync(join(FIXTURES_DIR, "simple-openapi.json"), "utf-8");
const SIMPLE_YAML_SPEC = readFileSync(join(FIXTURES_DIR, "simple-openapi.yaml"), "utf-8");

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ---------------------------------------------------------------------------
// Helper: mock fetch to return a given body string
// ---------------------------------------------------------------------------

function mockFetch(body: string, status = 200, contentType = "application/json"): void {
  globalThis.fetch = (async () =>
    new Response(body, {
      status,
      headers: { "content-type": contentType },
    })) as unknown as typeof fetch;
}

// ---------------------------------------------------------------------------
// TEST 1: Happy path — JSON spec parses into RestToolDefinition[]
// ---------------------------------------------------------------------------

describe("discoverToolsFromOpenApi — happy path JSON", () => {
  test("returns one tool per operation from a minimal OpenAPI 3.1 JSON spec", async () => {
    mockFetch(SIMPLE_JSON_SPEC);

    const { discoverToolsFromOpenApi } = await import("../../discovery/openapi-discovery.js");
    const tools = await discoverToolsFromOpenApi({
      openapiUrl: "http://example.com/openapi.json",
    });

    expect(Array.isArray(tools)).toBe(true);
    expect(tools.length).toBeGreaterThanOrEqual(1);

    // All tools must have required fields
    for (const tool of tools) {
      expect(typeof tool.name).toBe("string");
      expect(tool.name.length).toBeGreaterThan(0);
      expect(typeof tool.method).toBe("string");
      expect(typeof tool.endpoint).toBe("string");
      expect(typeof tool.description).toBe("string");
      expect(tool.inputSchema.type).toBe("object");
    }
  });

  test("list-users and create-user operations are both extracted", async () => {
    mockFetch(SIMPLE_JSON_SPEC);
    const { discoverToolsFromOpenApi } = await import("../../discovery/openapi-discovery.js");
    const tools = await discoverToolsFromOpenApi({ openapiUrl: "http://example.com/openapi.json" });

    const names = tools.map((t) => t.name);
    expect(names).toContain("list-users");
    expect(names).toContain("create-user");
  });
});

// ---------------------------------------------------------------------------
// TEST 2: YAML content type parses correctly
// ---------------------------------------------------------------------------

describe("discoverToolsFromOpenApi — YAML content type", () => {
  test("parses a YAML spec returned with text/yaml content-type", async () => {
    mockFetch(SIMPLE_YAML_SPEC, 200, "text/yaml");

    const { discoverToolsFromOpenApi } = await import("../../discovery/openapi-discovery.js");
    const tools = await discoverToolsFromOpenApi({ openapiUrl: "http://example.com/openapi.yaml" });

    expect(Array.isArray(tools)).toBe(true);
    expect(tools.length).toBeGreaterThanOrEqual(1);
    expect(tools[0].name).toBe("list-items");
  });
});

// ---------------------------------------------------------------------------
// TEST 3: Empty paths returns empty array without throwing
// ---------------------------------------------------------------------------

describe("discoverToolsFromOpenApi — empty paths", () => {
  test("returns empty array when spec has no path operations", async () => {
    const emptySpec = JSON.stringify({
      openapi: "3.1.0",
      info: { title: "Empty API", version: "1.0.0" },
      paths: {},
    });
    mockFetch(emptySpec);

    const { discoverToolsFromOpenApi } = await import("../../discovery/openapi-discovery.js");
    const tools = await discoverToolsFromOpenApi({ openapiUrl: "http://example.com/openapi.json" });

    expect(Array.isArray(tools)).toBe(true);
    expect(tools.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// TEST 4: Size cap — body exceeding 5 MB hardcoded limit is rejected
// ---------------------------------------------------------------------------

describe("discoverToolsFromOpenApi — size cap (hardcoded 5 MB)", () => {
  test("throws when response body exceeds 5 MB", async () => {
    // Generate a body just over 5 MB
    const FIVE_MB = 5 * 1024 * 1024;
    const bigBody = "x".repeat(FIVE_MB + 1);

    globalThis.fetch = (async () =>
      new Response(bigBody, {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;

    const { discoverToolsFromOpenApi } = await import("../../discovery/openapi-discovery.js");
    await expect(discoverToolsFromOpenApi({ openapiUrl: "http://example.com/openapi.json" })).rejects.toThrow(
      /too large/i,
    );
  });

  test("throws when content-length header exceeds 5 MB", async () => {
    const FIVE_MB = 5 * 1024 * 1024;

    globalThis.fetch = (async () =>
      new Response(SIMPLE_JSON_SPEC, {
        status: 200,
        headers: {
          "content-type": "application/json",
          "content-length": String(FIVE_MB + 1),
        },
      })) as unknown as typeof fetch;

    const { discoverToolsFromOpenApi } = await import("../../discovery/openapi-discovery.js");
    await expect(discoverToolsFromOpenApi({ openapiUrl: "http://example.com/openapi.json" })).rejects.toThrow(
      /too large/i,
    );
  });

  test("throws when a chunked body with NO content-length header exceeds 5 MB (cap enforced during the read, not just via the header)", async () => {
    // The DoS the streamed cap closes: a backend that omits content-length and
    // streams an oversized body must be rejected mid-read, never fully buffered.
    const FIVE_MB = 5 * 1024 * 1024;
    globalThis.fetch = (async () => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("x".repeat(FIVE_MB + 1)));
          controller.close();
        },
      });
      return new Response(stream, { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;

    const { discoverToolsFromOpenApi } = await import("../../discovery/openapi-discovery.js");
    await expect(discoverToolsFromOpenApi({ openapiUrl: "http://example.com/openapi.json" })).rejects.toThrow(
      /too large/i,
    );
  });
});

// ---------------------------------------------------------------------------
// TEST 5: Non-200 fetch response throws with clear message
// ---------------------------------------------------------------------------

describe("discoverToolsFromOpenApi — non-2xx response", () => {
  test("throws when the OpenAPI spec URL returns 404", async () => {
    mockFetch("Not found", 404, "text/plain");

    const { discoverToolsFromOpenApi } = await import("../../discovery/openapi-discovery.js");
    await expect(discoverToolsFromOpenApi({ openapiUrl: "http://example.com/openapi.json" })).rejects.toThrow(/404/);
  });
});

// ---------------------------------------------------------------------------
// TEST 6: Tag filtering — includeTags filters operations
// ---------------------------------------------------------------------------

describe("discoverToolsFromOpenApi — tag filtering", () => {
  test("only operations matching includeTags are returned", async () => {
    const taggedSpec = JSON.stringify({
      openapi: "3.1.0",
      info: { title: "Tagged API", version: "1.0.0" },
      paths: {
        "/users": {
          get: {
            operationId: "list-users",
            summary: "List users",
            tags: ["users"],
            responses: { "200": { description: "ok" } },
          },
        },
        "/orders": {
          get: {
            operationId: "list-orders",
            summary: "List orders",
            tags: ["orders"],
            responses: { "200": { description: "ok" } },
          },
        },
      },
    });
    mockFetch(taggedSpec);

    const { discoverToolsFromOpenApi } = await import("../../discovery/openapi-discovery.js");
    const tools = await discoverToolsFromOpenApi({
      openapiUrl: "http://example.com/openapi.json",
      includeTags: ["users"],
    });

    expect(tools.length).toBe(1);
    expect(tools[0].name).toBe("list-users");
  });
});

// ---------------------------------------------------------------------------
// TEST 7: x-internal operations are skipped
// ---------------------------------------------------------------------------

describe("discoverToolsFromOpenApi — x-internal skip", () => {
  test("operations with x-internal:true are not included in results", async () => {
    const spec = JSON.stringify({
      openapi: "3.1.0",
      info: { title: "Internal API", version: "1.0.0" },
      paths: {
        "/public": {
          get: {
            operationId: "public-op",
            summary: "Public endpoint",
            responses: { "200": { description: "ok" } },
          },
        },
        "/internal": {
          get: {
            operationId: "internal-op",
            summary: "Internal endpoint",
            "x-internal": true,
            responses: { "200": { description: "ok" } },
          },
        },
      },
    });
    mockFetch(spec);

    const { discoverToolsFromOpenApi } = await import("../../discovery/openapi-discovery.js");
    const tools = await discoverToolsFromOpenApi({ openapiUrl: "http://example.com/openapi.json" });

    const names = tools.map((t) => t.name);
    expect(names).toContain("public-op");
    expect(names).not.toContain("internal-op");
  });
});

// ---------------------------------------------------------------------------
// Tool-name sanitization — real-world specs routinely use camelCase
// operationIds, which registry.register() would otherwise always reject.
// ---------------------------------------------------------------------------

describe("discoverToolsFromOpenApi — tool name sanitization", () => {
  test("normalizes a camelCase operationId to the registry's tool-name rule", async () => {
    const spec = JSON.stringify({
      openapi: "3.0.0",
      info: { title: "demo", version: "1.0.0" },
      paths: {
        "/pets/{petId}": {
          put: { operationId: "updatePet", summary: "Update a pet", responses: { "200": { description: "ok" } } },
        },
      },
    });
    mockFetch(spec);
    const { discoverToolsFromOpenApi } = await import("../../discovery/openapi-discovery.js");
    const tools = await discoverToolsFromOpenApi({ openapiUrl: "http://example.com/openapi.json" });
    expect(tools.map((t) => t.name)).toEqual(["update_pet"]);
    expect(tools[0].name).toMatch(/^[a-z0-9][a-z0-9_-]{0,62}$/);
  });

  test("disambiguates two operationIds that normalize to the same name", async () => {
    const spec = JSON.stringify({
      openapi: "3.0.0",
      info: { title: "demo", version: "1.0.0" },
      paths: {
        "/a": { get: { operationId: "get_thing", summary: "a", responses: { "200": { description: "ok" } } } },
        "/b": { get: { operationId: "getThing", summary: "b", responses: { "200": { description: "ok" } } } },
      },
    });
    mockFetch(spec);
    const { discoverToolsFromOpenApi } = await import("../../discovery/openapi-discovery.js");
    const tools = await discoverToolsFromOpenApi({ openapiUrl: "http://example.com/openapi.json" });
    const names = tools.map((t) => t.name);
    expect(new Set(names).size).toBe(2);
    expect(names).toContain("get_thing");
    expect(names.some((n) => n === "get_thing_2")).toBe(true);
  });

  test("exclude_operations still matches the raw, pre-sanitization operationId", async () => {
    const spec = JSON.stringify({
      openapi: "3.0.0",
      info: { title: "demo", version: "1.0.0" },
      paths: {
        "/keep": { get: { operationId: "keepThis", summary: "keep", responses: { "200": { description: "ok" } } } },
        "/drop": { get: { operationId: "dropThis", summary: "drop", responses: { "200": { description: "ok" } } } },
      },
    });
    mockFetch(spec);
    const { discoverToolsFromOpenApi } = await import("../../discovery/openapi-discovery.js");
    const tools = await discoverToolsFromOpenApi({
      openapiUrl: "http://example.com/openapi.json",
      excludeOperations: ["dropThis"],
    });
    expect(tools.map((t) => t.name)).toEqual(["keep_this"]);
  });
});
