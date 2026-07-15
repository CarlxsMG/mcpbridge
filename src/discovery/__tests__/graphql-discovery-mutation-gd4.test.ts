/**
 * Stryker mutation-testing backstop for src/discovery/graphql-discovery.ts
 * (domain 6, cluster: "discoverToolsFromGraphQl — fetch, size limits, JSON
 * parse, cyclic-reference guard", lines 227-283).
 *
 * Baseline: 272 mutants, 118 killed, 154 survived, 43.38%.
 *
 * This file is self-contained (does not share fixtures/imports with the
 * sibling graphql-discovery.test.ts or the openapi-discovery-mutation-*
 * files) per this program's established convention — helper shapes
 * (typeRef/NON_NULL/LIST/SCALAR/NAMED/schema()) are redefined locally,
 * mirroring the existing suite's style.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { discoverToolsFromGraphQl } from "../../discovery/graphql-discovery.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ---------------------------------------------------------------------------
// Shared fixture helpers — same shapes as graphql-discovery.test.ts, redefined
// locally.
// ---------------------------------------------------------------------------

function typeRef(kind: string, name: string | null = null, ofType: unknown = null) {
  return { kind, name, ofType };
}
const NON_NULL = (of: unknown) => typeRef("NON_NULL", null, of);
const SCALAR = (name: string) => typeRef("SCALAR", name);
const NAMED = (kind: string, name: string) => typeRef(kind, name);

/** A small but fully valid introspection response: one query field, no mutations. */
function schema() {
  return {
    data: {
      __schema: {
        queryType: { name: "Query" },
        mutationType: null,
        types: [
          {
            kind: "OBJECT",
            name: "Query",
            fields: [
              {
                name: "pet",
                description: "Fetch a single pet by id",
                args: [{ name: "id", description: null, type: NON_NULL(SCALAR("ID")), defaultValue: null }],
                type: NAMED("OBJECT", "Pet"),
              },
            ],
            inputFields: null,
            enumValues: null,
          },
          {
            kind: "OBJECT",
            name: "Pet",
            fields: [{ name: "id", description: null, args: [], type: NON_NULL(SCALAR("ID")) }],
            inputFields: null,
            enumValues: null,
          },
          { kind: "SCALAR", name: "ID", fields: null, inputFields: null, enumValues: null },
        ],
      },
    },
  };
}

/** Minimal structurally-valid response with zero query fields, for size-boundary tests. */
const PLACEHOLDER = "__PAD__";
function minimalSkeleton() {
  return {
    data: {
      __schema: {
        queryType: { name: "Query" },
        mutationType: null,
        types: [{ kind: "OBJECT", name: "Query", fields: [], inputFields: null, enumValues: null }],
      },
    },
    xPad: PLACEHOLDER,
  };
}

interface CapturedCall {
  url: string;
  options: RequestInit;
}

/** Captures the fetch call args and always returns a valid schema() response. */
function mockFetchCapture(): { captured: CapturedCall | null } {
  const state: { captured: CapturedCall | null } = { captured: null };
  globalThis.fetch = (async (url: string | URL | Request, options?: RequestInit) => {
    state.captured = {
      url: typeof url === "string" ? url : url instanceof URL ? url.toString() : (url as Request).url,
      options: options ?? {},
    };
    return new Response(JSON.stringify(schema()), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return state;
}

function mockFetchRaw(body: string, status: number, headers: Record<string, string>): void {
  globalThis.fetch = (async () => new Response(body, { status, headers })) as unknown as typeof fetch;
}

// ---------------------------------------------------------------------------
// L237:48-237:110 ObjectLiteral (whole fetchHeaders literal emptied) +
// L237:66-237:84 StringLiteral ("application/json" -> "") +
// L237:90-237:107 LogicalOperator (`authHeaders ?? {}` -> `authHeaders && {}`).
//
// With authHeaders supplied, real code spreads authHeaders itself (`?? {}`
// only applies when authHeaders is null/undefined, so a truthy authHeaders
// wins outright); the `&&` mutant instead evaluates to the literal `{}` when
// authHeaders is truthy (JS `a && b` returns `b`), discarding the actual
// headers entirely. So a merged-headers assertion distinguishes `??` from
// `&&` here (unlike the "no authHeaders" case, where both operators
// coincidentally spread nothing extra).
// ---------------------------------------------------------------------------

describe("discoverToolsFromGraphQl — fetch headers: Content-Type + authHeaders merged", () => {
  test("Content-Type and a custom Authorization header are both sent when authHeaders is provided", async () => {
    const state = mockFetchCapture();
    await discoverToolsFromGraphQl({
      graphqlUrl: "http://example.test/graphql",
      authHeaders: { Authorization: "Bearer secret-token" },
    });

    const headers = state.captured!.options.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["Authorization"]).toBe("Bearer secret-token");
  });

  test("Content-Type alone is sent when authHeaders is omitted (?? {} fallback does not crash the spread)", async () => {
    const state = mockFetchCapture();
    await discoverToolsFromGraphQl({ graphqlUrl: "http://example.test/graphql" });

    const headers = state.captured!.options.headers as Record<string, string>;
    expect(headers).toEqual({ "Content-Type": "application/json" });
  });
});

// ---------------------------------------------------------------------------
// L238:7-238:12 ConditionalExpression false (`if (ipPin)` forced false) +
// L238:14-243:4 BlockStatement (whole ipPin body emptied) + L240:18-240:24
// StringLiteral ("Host" key emptied).
// ---------------------------------------------------------------------------

describe("discoverToolsFromGraphQl — ipPin rewrites the URL and sets a Host header", () => {
  test("fetched URL hostname is replaced with the pinned IP and a Host header carries the original hostname", async () => {
    const state = mockFetchCapture();
    await discoverToolsFromGraphQl({
      graphqlUrl: "https://example.test/graphql",
      ipPin: { resolvedIp: "1.2.3.4", hostname: "example.test" },
    });

    expect(state.captured!.url).toContain("1.2.3.4");
    expect(state.captured!.url).not.toContain("example.test/");

    // The pinned path routes through makePinnedFetch, which hands fetch a
    // Headers instance — normalize via `new Headers(...)` (case-insensitive .get).
    const headers = new Headers(state.captured!.options.headers);
    expect(headers.get("Host")).toBe("example.test");
  });

  test("without ipPin, the URL is fetched as-is and no Host header is set", async () => {
    const state = mockFetchCapture();
    await discoverToolsFromGraphQl({ graphqlUrl: "https://example.test/graphql" });

    expect(state.captured!.url).toBe("https://example.test/graphql");
    const headers = state.captured!.options.headers as Record<string, string>;
    expect(headers["Host"]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// L244:37-250:4 ObjectLiteral (whole fetch() options object emptied) +
// L245:13-245:19 StringLiteral ("POST" -> "") + L247:26-247:56 ObjectLiteral
// (`{ query: INTROSPECTION_QUERY }` body emptied).
// ---------------------------------------------------------------------------

describe("discoverToolsFromGraphQl — POST with an introspection-query body", () => {
  test("method is exactly POST and the body carries a non-empty introspection query", async () => {
    const state = mockFetchCapture();
    await discoverToolsFromGraphQl({ graphqlUrl: "http://example.test/graphql" });

    expect(state.captured!.options.method).toBe("POST");
    const parsedBody = JSON.parse(state.captured!.options.body as string) as { query?: unknown };
    expect(typeof parsedBody.query).toBe("string");
    expect((parsedBody.query as string).length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// L251:7-251:14 ConditionalExpression false (`if (!res.ok)` forced false) +
// L251:32-251:105 StringLiteral (error message template emptied).
// ---------------------------------------------------------------------------

describe("discoverToolsFromGraphQl — non-2xx introspection response is rejected", () => {
  test("a 500 response throws an Error whose message names the status code", async () => {
    mockFetchRaw("internal error", 500, { "content-type": "text/plain" });

    let caught: unknown;
    try {
      await discoverToolsFromGraphQl({ graphqlUrl: "http://example.test/graphql" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain("500");
    expect((caught as Error).message.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// L253:32-253:70 (ConditionalExpression + LogicalOperator `||` -> `&&`) on
// `Number(res.headers.get("content-length") || 0)`.
//
// Case (a): header entirely absent — confirms the fallback doesn't crash or
// produce NaN (both `||` and `&&` degrade to 0 here since `.get()` returns
// `null`, so this alone cannot distinguish the operators — see case (b) for
// the actual kill).
// ---------------------------------------------------------------------------

describe("discoverToolsFromGraphQl — missing content-length header does not crash", () => {
  test("a response with no content-length header still succeeds", async () => {
    mockFetchRaw(JSON.stringify(schema()), 200, { "content-type": "application/json" });
    const tools = await discoverToolsFromGraphQl({ graphqlUrl: "http://example.test/graphql" });
    expect(tools.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Case (b): a truthy content-length header ABOVE MAX_SPEC_SIZE with a small
// real body. Real code: `header || 0` picks the truthy header string, so
// `Number(header) > MAX_SPEC_SIZE` is true and it throws. The `&&` mutant
// instead evaluates `header && 0` to the literal `0` (JS `a && b` returns `b`
// when `a` is truthy) so `Number(0) > MAX_SPEC_SIZE` is false — no throw,
// the call would incorrectly succeed. This same case also kills the sibling
// L254 mutants (EqualityOperator `>` -> `>=`, the guard forced permanently
// false, and the emptied error-message BlockStatement/StringLiteral) since
// all of them would likewise fail to throw here.
// ---------------------------------------------------------------------------

describe("discoverToolsFromGraphQl — content-length header over the cap is rejected", () => {
  test("a content-length header of MAX_SPEC_SIZE + 1 throws a too-large error naming the byte count", async () => {
    const MAX_SPEC_SIZE = 5 * 1024 * 1024;
    mockFetchRaw(JSON.stringify(schema()), 200, {
      "content-type": "application/json",
      "content-length": String(MAX_SPEC_SIZE + 1),
    });

    let caught: unknown;
    try {
      await discoverToolsFromGraphQl({ graphqlUrl: "http://example.test/graphql" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/too large/i);
    expect((caught as Error).message).toContain(String(MAX_SPEC_SIZE + 1));
  });
});

// ---------------------------------------------------------------------------
// L254:7-254:36 (EqualityOperator `>` -> `>=`) boundary case: a content-length
// header of EXACTLY MAX_SPEC_SIZE, with a small real body, must succeed (the
// check is strictly-greater-than). Combined with the "+1" test above, this
// pins down the exact boundary and kills the `>=` swap in the opposite
// direction.
// ---------------------------------------------------------------------------

describe("discoverToolsFromGraphQl — content-length header boundary is exclusive", () => {
  test("a content-length header of exactly MAX_SPEC_SIZE is not rejected", async () => {
    const MAX_SPEC_SIZE = 5 * 1024 * 1024;
    mockFetchRaw(JSON.stringify(schema()), 200, {
      "content-type": "application/json",
      "content-length": String(MAX_SPEC_SIZE),
    });

    const tools = await discoverToolsFromGraphQl({ graphqlUrl: "http://example.test/graphql" });
    expect(tools.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// The real body-size cap is now enforced *during* the streaming read via
// `readBodyWithCap(res, MAX_SPEC_SIZE)` (proxy/http-util.ts), independent of
// the optional/spoofable content-length header check above — so a backend that
// omits or understates content-length can't stream an oversized body past it.
// These two tests exercise that streamed cap directly (no content-length
// header override involved).
//
// Boundary case: a real body of EXACTLY MAX_SPEC_SIZE bytes succeeds (the cap
// is exclusive — `totalBytes > MAX_SPEC_SIZE`).
// ---------------------------------------------------------------------------

describe("discoverToolsFromGraphQl — streamed body-length cap is exclusive at the boundary", () => {
  test("a response body of exactly MAX_SPEC_SIZE characters is not rejected as too large", async () => {
    const MAX_SPEC_SIZE = 5 * 1024 * 1024;
    const withPlaceholder = JSON.stringify(minimalSkeleton());
    const baseLen = withPlaceholder.length - PLACEHOLDER.length;
    const padLen = MAX_SPEC_SIZE - baseLen;
    expect(padLen).toBeGreaterThan(0);
    const text = withPlaceholder.replace(PLACEHOLDER, "a".repeat(padLen));
    expect(text.length).toBe(MAX_SPEC_SIZE);

    mockFetchRaw(text, 200, { "content-type": "application/json" });
    const tools = await discoverToolsFromGraphQl({ graphqlUrl: "http://example.test/graphql" });
    expect(tools).toEqual([]);
  });

  // Over-the-boundary case: an oversized body is rejected as it streams in,
  // before it is ever fully buffered (the memory-DoS guard). Because the read
  // is cancelled the instant the cap is crossed, the error names the cap
  // rather than the deliberately-never-counted received size.
  test("a response body of MAX_SPEC_SIZE + 1 characters is rejected as too large during the streamed read", async () => {
    const MAX_SPEC_SIZE = 5 * 1024 * 1024;
    const withPlaceholder = JSON.stringify(minimalSkeleton());
    const baseLen = withPlaceholder.length - PLACEHOLDER.length;
    const padLen = MAX_SPEC_SIZE + 1 - baseLen;
    const text = withPlaceholder.replace(PLACEHOLDER, "a".repeat(padLen));
    expect(text.length).toBe(MAX_SPEC_SIZE + 1);

    mockFetchRaw(text, 200, { "content-type": "application/json" });

    let caught: unknown;
    try {
      await discoverToolsFromGraphQl({ graphqlUrl: "http://example.test/graphql" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/too large/i);
    expect((caught as Error).message).toContain(String(MAX_SPEC_SIZE));
  });
});

// ---------------------------------------------------------------------------
// L271:7-273:4 BlockStatement (the `try { JSON.stringify(json); }` body
// emptied) + L273:17-279:4 BlockStatement (the catch body emptied) +
// L274:9-274:33 ConditionalExpression (`err instanceof TypeError` forced
// true/false) + L275:23-275:103 StringLiteral (message emptied) +
// L275:105-277:8 ObjectLiteral (`{ cause: err }` emptied).
//
// The source comment notes a fresh JSON.parse result can never actually be
// cyclic (this file, unlike openapi-discovery.ts, never runs a YAML parser
// that could produce real aliased/circular structures) — so the intended
// "GRAPHQL_CYCLIC_REFERENCE" TypeError branch is genuinely unreachable via
// the public API. However, `JSON.stringify` can still fail for a NON-cyclic
// reason: a sufficiently deep (but tree-shaped, acyclic) object blows its
// own native recursion limit and throws a RangeError — verified empirically
// above (60,000 levels reliably throws "Maximum call stack size exceeded" in
// this Bun runtime), mirroring the technique used in
// openapi-discovery-mutation-od1.test.ts. This proves the try/catch
// structure itself IS reachable and observable, even though the TypeError
// arm specifically is not.
// ---------------------------------------------------------------------------

describe("discoverToolsFromGraphQl — a deep-but-acyclic stringify stack overflow is not mislabeled as cyclic", () => {
  test("a RangeError from JSON.stringify's own recursion limit propagates unwrapped, not as GRAPHQL_CYCLIC_REFERENCE", async () => {
    // Built via string concatenation (not JSON.stringify, which would itself
    // blow the stack constructing the fixture); JSON.parse tolerates much
    // deeper nesting than JSON.stringify in this runtime, so the parse below
    // succeeds and this test hits the JSON.stringify(json) call specifically.
    const DEPTH = 60000;
    const text = '{"a":'.repeat(DEPTH) + "true" + "}".repeat(DEPTH);
    expect(text.length).toBeLessThan(5 * 1024 * 1024);

    mockFetchRaw(text, 200, { "content-type": "application/json" });

    let caught: unknown;
    try {
      await discoverToolsFromGraphQl({ graphqlUrl: "http://example.test/graphql" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(RangeError);
    expect((caught as Error).message).not.toMatch(/GRAPHQL_CYCLIC_REFERENCE/i);
  });
});
