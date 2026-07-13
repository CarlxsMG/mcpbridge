import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";

// Stryker mutation backstop — RG3 (src/mcp/registration.ts lines 279-391): the
// REST of performRestRegistration — tool resolution (four branches: OpenAPI
// discovery, cURL parsing, Postman parsing, or a hand-written 'tools' array),
// the curl/postman-only tools-count cap, endpoint path-traversal validation,
// the registry.register(...) call, and the success/error response shapes.
//
// A sibling agent covers the SAME function's earlier validation gauntlet
// (name/health_url/base_url/SSRF, lines before 279) in
// registration-mutation-rg2.test.ts. This file uses a distinct "rg3-" client
// name prefix to keep the two files' fixtures visually distinguishable, even
// though each test's own beforeEach fully wipes the registry + DB regardless
// of what any other file left behind (same pattern already established by
// registry-mutation-rc1..rc10.test.ts).
//
// Each test/comment cites the exact line:column, mutator, and replacement it
// targets, per the house convention (see stryker.config.mjs SCOPE HISTORY).
//
// Discovery-source functions (discoverToolsFromOpenApi, parseCurlCommand,
// parsePostmanCollection) and the SSRF check (validateBackendUrl) are mocked
// at the source-function level via spyOn on their owning module's namespace
// object — this keeps the tests fast and focused on registration.ts's own
// glue logic; those other files have their own dedicated mutation-testing
// responsibility. registry.register() itself is REAL (not mocked), so
// success-path assertions read back genuine post-registration state via
// registry.getClient(...) — this is what lets us pin the retry_non_safe_methods
// === true coercion and the exact health/base/ip values threaded through.

import { performRestRegistration } from "../registration.js";
import { registry } from "../registry.js";
import { __resetDbForTesting } from "../../db/connection.js";
import { config } from "../../config.js";
import * as ipValidatorMod from "../../net/ip-validator.js";
import * as openapiDiscoveryMod from "../../discovery/openapi-discovery.js";
import * as curlPostmanMod from "../../discovery/curl-postman-discovery.js";
import * as loggerMod from "../../logger.js";
import type { RestToolDefinition } from "../types.js";

// ---------------------------------------------------------------------------
// Fixtures / helpers
// ---------------------------------------------------------------------------

const HEALTH_URL = "http://health.rg3.test/health";
const BASE_URL = "http://base.rg3.test";
const HEALTH_IP = "10.1.1.1";
const BASE_IP = "10.2.2.2";
// Fallback resolvedIp for any URL validateBackendUrl is asked to validate that
// a given test didn't explicitly register in `extraValidate` below (keeps
// every test's mock total, so an unexpected extra call never silently
// succeeds against production DNS/network).
const DEFAULT_FALLBACK_IP = "10.9.9.9";

function makeTool(name: string, overrides: Partial<RestToolDefinition> = {}): RestToolDefinition {
  return {
    name,
    method: "GET",
    endpoint: `/rg3/${name}`,
    description: `RG3 fixture tool ${name}`,
    inputSchema: { type: "object", properties: {} },
    ...overrides,
  };
}

function body(overrides: Record<string, unknown>): Record<string, unknown> {
  return { health_url: HEALTH_URL, base_url: BASE_URL, ...overrides };
}

const ORIGINAL_MAX_TOOLS = config.maxToolsPerClient;

let extraValidate: Record<string, { valid: true; resolvedIp: string } | { valid: false; reason: string }>;
let validateSpy: ReturnType<typeof spyOn>;
let openapiSpy: ReturnType<typeof spyOn>;
let curlSpy: ReturnType<typeof spyOn>;
let postmanSpy: ReturnType<typeof spyOn>;
let logSpy: ReturnType<typeof spyOn>;

beforeEach(async () => {
  for (const c of registry.listClients()) await registry.unregister(c.name);
  __resetDbForTesting();
  (config as Record<string, unknown>).maxToolsPerClient = ORIGINAL_MAX_TOOLS;

  extraValidate = {};
  validateSpy = spyOn(ipValidatorMod, "validateBackendUrl").mockImplementation(async (url: string) => {
    if (url === HEALTH_URL) return { valid: true, resolvedIp: HEALTH_IP };
    if (url === BASE_URL) return { valid: true, resolvedIp: BASE_IP };
    if (url in extraValidate) return extraValidate[url];
    return { valid: true, resolvedIp: DEFAULT_FALLBACK_IP };
  });
  // No default mockImplementation for the discovery/parse spies — each test
  // sets its own return/throw. Left un-mocked (spy still records calls) for
  // tests that assert a given source function was never called at all.
  openapiSpy = spyOn(openapiDiscoveryMod, "discoverToolsFromOpenApi");
  curlSpy = spyOn(curlPostmanMod, "parseCurlCommand");
  postmanSpy = spyOn(curlPostmanMod, "parsePostmanCollection");
  logSpy = spyOn(loggerMod, "log").mockImplementation(() => {});
});

afterEach(() => {
  validateSpy.mockRestore();
  openapiSpy.mockRestore();
  curlSpy.mockRestore();
  postmanSpy.mockRestore();
  logSpy.mockRestore();
  (config as Record<string, unknown>).maxToolsPerClient = ORIGINAL_MAX_TOOLS;
});

// ---------------------------------------------------------------------------
// L281:7 BlockStatement->{}, L282:9 ConditionalExpression->true/false —
// `if (openapi_url) { ... }`. An emptied block (or a condition forced to
// always-false while openapi_url IS provided) leaves `resolvedTools`
// unassigned (`let resolvedTools;` at L280), which blows up as a TypeError
// later (`resolvedTools.length`/iterating undefined) — caught by the outer
// catch and turned into an error response instead of the real success. A
// condition forced to always-true when openapi_url is NOT provided wrongly
// enters this branch and calls `.startsWith` on undefined, also erroring.
//
// L292/L294/L296 — the discoverToolsFromOpenApi({...}) call: assert the EXACT
// 4-field options object, including that ipPin.resolvedIp comes from the
// openapi_url's OWN validateBackendUrl call (not health's or base's — proven
// here by giving each of the three URLs a distinct resolvedIp and asserting
// each field lands in the right place) and hostname is derived from the
// resolved openapi URL, not the raw input.
// ---------------------------------------------------------------------------

describe("openapi_url branch — success path (L281/L282/L292/L294/L296)", () => {
  test("absolute openapi_url: succeeds, calls discoverToolsFromOpenApi with the exact options object, registers with base's (not openapi's) resolvedIp", async () => {
    const openapiUrl = "https://spec.rg3.test/openapi.json";
    const OPENAPI_IP = "10.3.3.3";
    extraValidate[openapiUrl] = { valid: true, resolvedIp: OPENAPI_IP };
    openapiSpy.mockResolvedValueOnce([makeTool("tool-a")]);

    const result = await performRestRegistration(
      body({
        name: "rg3-openapi-abs",
        openapi_url: openapiUrl,
        include_tags: ["tag-a"],
        exclude_operations: ["op-x"],
      }),
      undefined,
      "req-openapi-abs",
    );

    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      status: "registered",
      name: "rg3-openapi-abs",
      tools_count: 1,
      source: "openapi",
    });

    expect(openapiSpy).toHaveBeenCalledTimes(1);
    expect(openapiSpy.mock.calls[0][0]).toEqual({
      openapiUrl,
      ipPin: { resolvedIp: OPENAPI_IP, hostname: "spec.rg3.test" },
      includeTags: ["tag-a"],
      excludeOperations: ["op-x"],
    });

    // Confirms registry.register() got BASE's resolvedIp (pinnedIp), not
    // openapi's — the two must never be conflated.
    const client = registry.getClient("rg3-openapi-abs");
    expect(client?.resolved_ip).toBe(BASE_IP);
    expect(client?.health_url).toBe(HEALTH_URL);
    expect(client?.base_url).toBe(BASE_URL);

    expect(logSpy).toHaveBeenCalledWith("info", "Client registered", {
      name: "rg3-openapi-abs",
      tools_count: 1,
      source: "openapi",
    });
  });

  test("curl_input success path proves the openapi if-condition doesn't wrongly fire when openapi_url is absent (L282 forced-true direction)", async () => {
    curlSpy.mockReturnValueOnce([makeTool("tool-curl")]);
    const result = await performRestRegistration(
      body({ name: "rg3-curl-not-openapi", curl_input: "curl https://example.com" }),
      undefined,
      "req-curl-guard",
    );
    expect(result.ok).toBe(true);
    expect(openapiSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// L285 (MethodExpression, StringLiteral x2) — the relative-openapi_url
// URL-building ternary:
//   `http://${ip}${openapi_url.startsWith("/") ? "" : "/"}${openapi_url}`
// Test both a relative path WITHOUT a leading slash (must gain exactly one
// inserted "/") and WITH a leading slash (must NOT double it up).
// ---------------------------------------------------------------------------

describe("openapi_url branch — relative-URL resolution (L285)", () => {
  test("relative openapi_url without a leading slash gets exactly one '/' inserted before it", async () => {
    const peerIp = "10.20.30.40";
    const expectedUrl = `http://${peerIp}/spec/openapi.json`;
    const OPENAPI_IP = "10.3.3.4";
    extraValidate[expectedUrl] = { valid: true, resolvedIp: OPENAPI_IP };
    openapiSpy.mockResolvedValueOnce([makeTool("tool-b")]);

    const result = await performRestRegistration(
      body({ name: "rg3-openapi-rel-noslash", openapi_url: "spec/openapi.json" }),
      peerIp,
      "req-rel-noslash",
    );

    expect(result.ok).toBe(true);
    expect(validateSpy.mock.calls.some((c: unknown[]) => c[0] === expectedUrl)).toBe(true);
    expect(openapiSpy.mock.calls[0][0]).toMatchObject({
      openapiUrl: expectedUrl,
      ipPin: { resolvedIp: OPENAPI_IP, hostname: peerIp },
    });
  });

  test("relative openapi_url WITH a leading slash is not double-slashed", async () => {
    const peerIp = "10.20.30.41";
    const expectedUrl = `http://${peerIp}/spec2/openapi.json`;
    const OPENAPI_IP = "10.3.3.5";
    extraValidate[expectedUrl] = { valid: true, resolvedIp: OPENAPI_IP };
    openapiSpy.mockResolvedValueOnce([makeTool("tool-c")]);

    const result = await performRestRegistration(
      body({ name: "rg3-openapi-rel-slash", openapi_url: "/spec2/openapi.json" }),
      peerIp,
      "req-rel-slash",
    );

    expect(result.ok).toBe(true);
    // Exact-match lookup: if a "//" got inserted, this exact string would
    // never have been the key validateBackendUrl was called with, and the
    // call would have fallen through to the DEFAULT_FALLBACK_IP branch
    // instead — so this assertion alone distinguishes the mutant.
    expect(validateSpy.mock.calls.some((c: unknown[]) => c[0] === expectedUrl)).toBe(true);
    expect(
      validateSpy.mock.calls.some((c: unknown[]) => typeof c[0] === "string" && (c[0] as string).includes("//spec2")),
    ).toBe(false);
    expect(openapiSpy.mock.calls[0][0]).toMatchObject({ openapiUrl: expectedUrl });
  });
});

// ---------------------------------------------------------------------------
// L283:57 StringLiteral -> '' — `Invalid openapi_url: ${reason}`. Also
// exercises L281/L282's guard (the error must come from INSIDE the
// `if (openapi_url)` branch) and confirms this specific error has NO
// request_id field (unlike the cap-check/endpoint-traversal errors below).
// ---------------------------------------------------------------------------

describe("openapi_url branch — SSRF-invalid openapi_url (L283:57)", () => {
  test("invalid openapi_url produces the exact 'Invalid openapi_url: <reason>' message, no request_id", async () => {
    const openapiUrl = "https://blocked.rg3.test/openapi.json";
    extraValidate[openapiUrl] = { valid: false, reason: "blocked host" };

    const result = await performRestRegistration(
      body({ name: "rg3-openapi-invalid", openapi_url: openapiUrl }),
      undefined,
      "req-openapi-invalid",
    );

    expect(result.ok).toBe(false);
    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({
      error: { code: "VALIDATION_ERROR", message: "Invalid openapi_url: blocked host" },
    });
    expect((result.body as { error: { request_id?: string } }).error.request_id).toBeUndefined();
    expect(openapiSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// L308/L309/L314 — `if (resolvedTools.length === 0) return {...DISCOVERY_ERROR
// "No tools discovered from OpenAPI spec. Check include_tags/exclude_operations
// filters."...}`. A non-empty resolve proceeds (already proven by the success
// test above).
// ---------------------------------------------------------------------------

describe("openapi_url branch — zero tools discovered (L308/L309/L314)", () => {
  test("an empty discoverToolsFromOpenApi resolve produces the exact DISCOVERY_ERROR", async () => {
    openapiSpy.mockResolvedValueOnce([]);
    const result = await performRestRegistration(
      body({ name: "rg3-openapi-empty", openapi_url: "https://empty.rg3.test/openapi.json" }),
      undefined,
      "req-openapi-empty",
    );
    expect(result.ok).toBe(false);
    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({
      error: {
        code: "DISCOVERY_ERROR",
        message: "No tools discovered from OpenAPI spec. Check include_tags/exclude_operations filters.",
      },
    });
  });
});

// ---------------------------------------------------------------------------
// L343-352 — the curl/postman-only tools-count cap does NOT apply to the
// openapi branch (no cap check anywhere in this function for it — confirmed
// by source inspection). A huge openapi-discovered tool set must still
// register successfully.
// ---------------------------------------------------------------------------

describe("openapi_url branch — no tools-count cap applies here (L343 LogicalOperator)", () => {
  test("openapi tool count exceeding maxToolsPerClient still succeeds (uncapped for this source)", async () => {
    (config as Record<string, unknown>).maxToolsPerClient = 1;
    openapiSpy.mockResolvedValueOnce([makeTool("tool-x"), makeTool("tool-y"), makeTool("tool-z")]);
    const result = await performRestRegistration(
      body({ name: "rg3-openapi-uncapped", openapi_url: "https://big.rg3.test/openapi.json" }),
      undefined,
      "req-openapi-uncapped",
    );
    expect(result.ok).toBe(true);
    expect(result.body).toMatchObject({ tools_count: 3, source: "openapi" });
  });
});

// ---------------------------------------------------------------------------
// L377/L379 (catch block) — an openapi_url registration whose
// discoverToolsFromOpenApi call REJECTS gets code "DISCOVERY_ERROR" (since
// openapi_url is truthy), with the thrown error's own message.
// ---------------------------------------------------------------------------

describe("openapi_url branch — discovery throws (L377/L379 catch code selection)", () => {
  test("a rejected discoverToolsFromOpenApi call yields DISCOVERY_ERROR with the thrown message", async () => {
    openapiSpy.mockRejectedValueOnce(new Error("upstream spec fetch boom"));
    const result = await performRestRegistration(
      body({ name: "rg3-openapi-throws", openapi_url: "https://boom.rg3.test/openapi.json" }),
      undefined,
      "req-openapi-throws",
    );
    expect(result.ok).toBe(false);
    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({
      error: { code: "DISCOVERY_ERROR", message: "upstream spec fetch boom" },
    });
  });
});

// ---------------------------------------------------------------------------
// L320 (ConditionalExpression x2) — `else if (hasCurl)` branch selection.
// Verify curl parsing runs (and openapi/postman discovery do NOT) when curl
// is the active source, and that a parse failure surfaces as VALIDATION_ERROR
// (not DISCOVERY_ERROR — openapi_url is falsy here).
// ---------------------------------------------------------------------------

describe("hasCurl branch (L320)", () => {
  test("curl_input active source: parseCurlCommand is called and is the ONLY source function invoked; source:'manual' in the response", async () => {
    curlSpy.mockReturnValueOnce([makeTool("tool-curl-1"), makeTool("tool-curl-2")]);
    const result = await performRestRegistration(
      body({ name: "rg3-curl-success", curl_input: "curl https://api.rg3.test/widgets" }),
      undefined,
      "req-curl-success",
    );
    expect(result.ok).toBe(true);
    expect(result.body).toMatchObject({ tools_count: 2, source: "manual" });
    expect(curlSpy).toHaveBeenCalledTimes(1);
    expect(curlSpy.mock.calls[0][0]).toBe("curl https://api.rg3.test/widgets");
    expect(postmanSpy).not.toHaveBeenCalled();
    expect(openapiSpy).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith("info", "Client registered", {
      name: "rg3-curl-success",
      tools_count: 2,
      source: "manual",
    });
  });

  test("a parseCurlCommand throw yields VALIDATION_ERROR (openapi_url is falsy) with the exact thrown message", async () => {
    curlSpy.mockImplementationOnce(() => {
      throw new Error("unparseable curl command");
    });
    const result = await performRestRegistration(
      body({ name: "rg3-curl-throws", curl_input: "not a curl command" }),
      undefined,
      "req-curl-throws",
    );
    expect(result.ok).toBe(false);
    expect(result.body).toMatchObject({
      error: { code: "VALIDATION_ERROR", message: "unparseable curl command" },
    });
  });
});

// ---------------------------------------------------------------------------
// L325/L326 — postman_collection typeof-string ternary:
//   typeof postman_collection === "string" ? JSON.parse(postman_collection)
//                                           : postman_collection
// Both directions: a JSON-STRING collection must be parsed before being
// handed to parsePostmanCollection; an already-parsed OBJECT must be passed
// through by the SAME reference, never re-JSON.parsed (which would throw on
// a non-string argument).
// ---------------------------------------------------------------------------

describe("hasPostman branch — string vs. object collection (L325/L326)", () => {
  test("a JSON-STRING postman_collection is parsed into an object before reaching parsePostmanCollection", async () => {
    const raw = { info: { name: "rg3" }, item: [] };
    postmanSpy.mockReturnValueOnce([makeTool("tool-pm-1")]);
    const result = await performRestRegistration(
      body({ name: "rg3-postman-string", postman_collection: JSON.stringify(raw) }),
      undefined,
      "req-postman-string",
    );
    expect(result.ok).toBe(true);
    expect(postmanSpy).toHaveBeenCalledTimes(1);
    const receivedArg = postmanSpy.mock.calls[0][0];
    expect(typeof receivedArg).toBe("object");
    expect(receivedArg).toEqual(raw);
    expect(curlSpy).not.toHaveBeenCalled();
    expect(openapiSpy).not.toHaveBeenCalled();
  });

  test("an already-parsed OBJECT postman_collection is passed through by reference, NOT re-JSON.parsed", async () => {
    const raw = { info: { name: "rg3-obj" }, item: [] };
    postmanSpy.mockReturnValueOnce([makeTool("tool-pm-2")]);
    const result = await performRestRegistration(
      body({ name: "rg3-postman-object", postman_collection: raw }),
      undefined,
      "req-postman-object",
    );
    // If the mutant forced JSON.parse to run on a plain object, JSON.parse
    // would receive String(raw) === "[object Object]" and throw a
    // SyntaxError, which would be caught below and turn this into an error
    // response instead of a success — so `ok:true` alone already
    // distinguishes that direction.
    expect(result.ok).toBe(true);
    expect(postmanSpy).toHaveBeenCalledTimes(1);
    expect(postmanSpy.mock.calls[0][0]).toBe(raw);
  });

  test("a parsePostmanCollection throw yields VALIDATION_ERROR with the exact thrown message", async () => {
    postmanSpy.mockImplementationOnce(() => {
      throw new Error("malformed postman collection");
    });
    const result = await performRestRegistration(
      body({ name: "rg3-postman-throws", postman_collection: { info: {}, item: [] } }),
      undefined,
      "req-postman-throws",
    );
    expect(result.ok).toBe(false);
    expect(result.body).toMatchObject({
      error: { code: "VALIDATION_ERROR", message: "malformed postman collection" },
    });
  });
});

// ---------------------------------------------------------------------------
// L329/L330 — manual `tools` array branch:
//   if (!Array.isArray(tools)) return {...'tools' must be an array'...};
// Both directions: a non-array `tools` value fails with the exact message (no
// request_id); a real array proceeds directly, calling NONE of the three
// discovery/parse functions.
// ---------------------------------------------------------------------------

describe("manual 'tools' array branch (L329/L330)", () => {
  test("a non-array 'tools' value is rejected with the exact message, no request_id", async () => {
    const result = await performRestRegistration(
      body({ name: "rg3-tools-not-array", tools: { not: "an array" } }),
      undefined,
      "req-tools-not-array",
    );
    expect(result.ok).toBe(false);
    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({
      error: { code: "VALIDATION_ERROR", message: "'tools' must be an array" },
    });
    expect((result.body as { error: { request_id?: string } }).error.request_id).toBeUndefined();
  });

  test("a real 'tools' array proceeds directly — no discovery/parse function is called at all", async () => {
    const result = await performRestRegistration(
      body({ name: "rg3-tools-array", tools: [makeTool("tool-manual-1"), makeTool("tool-manual-2")] }),
      undefined,
      "req-tools-array",
    );
    expect(result.ok).toBe(true);
    expect(result.body).toMatchObject({ tools_count: 2, source: "manual" });
    expect(openapiSpy).not.toHaveBeenCalled();
    expect(curlSpy).not.toHaveBeenCalled();
    expect(postmanSpy).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith("info", "Client registered", {
      name: "rg3-tools-array",
      tools_count: 2,
      source: "manual",
    });
  });
});

// ---------------------------------------------------------------------------
// L343-352 — `if (hasCurl || hasPostman) { const capError = ...; if
// (capError) return {...}; }`. This cap ONLY applies to curl/postman results:
// a curl/postman result exceeding config.maxToolsPerClient is rejected with
// the cap error INCLUDING request_id (unlike toolsCountCapError's own bare
// message); a manual result of the same size is NOT capped here (that's
// enforced earlier, at the Express route layer — out of scope for this
// function, per the source comment above L343).
// ---------------------------------------------------------------------------

describe("tools-count cap — curl/postman only (L343-352)", () => {
  test("curl result exceeding maxToolsPerClient is rejected with the exact capped message + request_id", async () => {
    (config as Record<string, unknown>).maxToolsPerClient = 2;
    curlSpy.mockReturnValueOnce([makeTool("tool-1"), makeTool("tool-2"), makeTool("tool-3")]);
    const result = await performRestRegistration(
      body({ name: "rg3-curl-capped", curl_input: "curl https://api.rg3.test/many" }),
      undefined,
      "req-curl-capped",
    );
    expect(result.ok).toBe(false);
    expect(result.status).toBe(400);
    expect(result.body).toEqual({
      error: {
        code: "VALIDATION_ERROR",
        message: "Parsed 3 tools, exceeds maximum of 2",
        request_id: "req-curl-capped",
      },
    });
  });

  test("postman result exceeding maxToolsPerClient is rejected with the exact capped message + request_id", async () => {
    (config as Record<string, unknown>).maxToolsPerClient = 1;
    postmanSpy.mockReturnValueOnce([makeTool("tool-p1"), makeTool("tool-p2")]);
    const result = await performRestRegistration(
      body({ name: "rg3-postman-capped", postman_collection: { info: {}, item: [] } }),
      undefined,
      "req-postman-capped",
    );
    expect(result.ok).toBe(false);
    expect(result.body).toEqual({
      error: {
        code: "VALIDATION_ERROR",
        message: "Parsed 2 tools, exceeds maximum of 1",
        request_id: "req-postman-capped",
      },
    });
  });

  test("a manual 'tools' array of the same oversized length is NOT capped inside performRestRegistration", async () => {
    (config as Record<string, unknown>).maxToolsPerClient = 1;
    const result = await performRestRegistration(
      body({
        name: "rg3-manual-uncapped",
        tools: [makeTool("tool-m1"), makeTool("tool-m2"), makeTool("tool-m3")],
      }),
      undefined,
      "req-manual-uncapped",
    );
    expect(result.ok).toBe(true);
    expect(result.body).toMatchObject({ tools_count: 3, source: "manual" });
  });
});

// ---------------------------------------------------------------------------
// L358-364 — `findToolEndpointError(resolvedTools)` check: exact error
// message (registration.ts's own `Tool "<name>": <pathError>` format, WITH a
// colon) plus request_id. If the surrounding `if (endpointError)` guard were
// bypassed (BlockStatement->{} or ConditionalExpression->false), the bad tool
// would instead reach registry.register()'s OWN traversal check, which throws
// a DIFFERENTLY-formatted message (`Tool "<name>" <pathError>`, no colon) via
// the generic catch block below — which also omits request_id entirely. So
// asserting the exact colon-including message AND the presence of request_id
// together distinguishes every variant of this mutant.
// ---------------------------------------------------------------------------

describe("endpoint path-traversal validation (L358-364)", () => {
  test("a resolved tool with a path-traversal endpoint is rejected with the exact registration.ts-formatted message + request_id", async () => {
    const result = await performRestRegistration(
      body({
        name: "rg3-traversal",
        tools: [makeTool("bad-tool", { endpoint: "/a/../secret" })],
      }),
      undefined,
      "req-traversal",
    );
    expect(result.ok).toBe(false);
    expect(result.status).toBe(400);
    expect(result.body).toEqual({
      error: {
        code: "VALIDATION_ERROR",
        message: 'Tool "bad-tool": Endpoint contains invalid path segment: /a/../secret',
        request_id: "req-traversal",
      },
    });
  });

  test("a clean endpoint with a normal trailing segment passes through to registration (baseline, no traversal)", async () => {
    const result = await performRestRegistration(
      body({
        name: "rg3-clean-endpoint",
        tools: [makeTool("ok-tool", { endpoint: "/users/:id/profile" })],
      }),
      undefined,
      "req-clean-endpoint",
    );
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// L366-374 — the registry.register(...) call itself: exact positional args
// (health/ip/base/pinnedIp all land correctly) and the
// `retry_non_safe_methods === true` STRICT boolean coercion (L373
// EqualityOperator) — only the literal boolean `true` may set it; any other
// truthy value must NOT pass through.
// ---------------------------------------------------------------------------

describe("registry.register(...) call — resolved args + retry_non_safe_methods coercion (L366-374)", () => {
  test("registered client reflects the exact resolved health_url/base_url/ip/resolvedIp", async () => {
    const peerIp = "10.50.50.50";
    const result = await performRestRegistration(
      body({ name: "rg3-register-args", tools: [makeTool("tool-args")] }),
      peerIp,
      "req-register-args",
    );
    expect(result.ok).toBe(true);
    const client = registry.getClient("rg3-register-args");
    expect(client?.health_url).toBe(HEALTH_URL);
    expect(client?.base_url).toBe(BASE_URL);
    expect(client?.ip).toBe(peerIp);
    expect(client?.resolved_ip).toBe(BASE_IP);
  });

  test("retry_non_safe_methods: literal true sets the client's flag to true", async () => {
    const result = await performRestRegistration(
      body({ name: "rg3-retry-true", tools: [makeTool("tool-rt-1")], retry_non_safe_methods: true }),
      undefined,
      "req-retry-true",
    );
    expect(result.ok).toBe(true);
    expect(registry.getClient("rg3-retry-true")?.retry_non_safe_methods).toBe(true);
  });

  test("retry_non_safe_methods: a truthy non-boolean ('yes') is coerced to false, not passed through (kills L373 EqualityOperator ===/!==)", async () => {
    const result = await performRestRegistration(
      body({ name: "rg3-retry-yes-string", tools: [makeTool("tool-rt-2")], retry_non_safe_methods: "yes" }),
      undefined,
      "req-retry-yes",
    );
    expect(result.ok).toBe(true);
    expect(registry.getClient("rg3-retry-yes-string")?.retry_non_safe_methods).toBe(false);
  });

  test("retry_non_safe_methods omitted defaults to false", async () => {
    const result = await performRestRegistration(
      body({ name: "rg3-retry-omitted", tools: [makeTool("tool-rt-3")] }),
      undefined,
      "req-retry-omitted",
    );
    expect(result.ok).toBe(true);
    expect(registry.getClient("rg3-retry-omitted")?.retry_non_safe_methods).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// L377-389 — catch block code selection (openapi_url truthy => DISCOVERY_ERROR
// tested above; openapi_url falsy => VALIDATION_ERROR tested here via a
// downstream registry.register() throw reached only after this function's
// own checks all pass) and the success response's exact `source`/`tools_count`
// fields, including that curl/postman ALSO report source:"manual" (not a
// distinct "curl"/"postman" value).
// ---------------------------------------------------------------------------

describe("catch block — VALIDATION_ERROR from a downstream registry.register() throw (L377/L379)", () => {
  test("an invalid tool name reaching registry.register() surfaces as VALIDATION_ERROR with registry.ts's own exact message", async () => {
    const result = await performRestRegistration(
      body({ name: "rg3-bad-tool-name", tools: [makeTool("Bad Name!")] }),
      undefined,
      "req-bad-tool-name",
    );
    expect(result.ok).toBe(false);
    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({
      error: {
        code: "VALIDATION_ERROR",
        message: "Tool 'Bad Name!': name must be lowercase alphanumeric with hyphens/underscores, 1-63 chars",
      },
    });
    // registry.register()'s own throw is caught by the generic catch block,
    // which (unlike the cap/traversal checks above) does NOT attach request_id.
    expect((result.body as { error: { request_id?: string } }).error.request_id).toBeUndefined();
  });
});

describe("success response — exact source/tools_count per branch (L384/L389)", () => {
  test("curl and postman sources both report source:'manual' (not 'curl'/'postman')", async () => {
    curlSpy.mockReturnValueOnce([makeTool("tool-src-curl")]);
    const curlResult = await performRestRegistration(
      body({ name: "rg3-source-curl", curl_input: "curl https://api.rg3.test/x" }),
      undefined,
      "req-source-curl",
    );
    expect(curlResult.body).toMatchObject({ source: "manual", tools_count: 1 });

    postmanSpy.mockReturnValueOnce([makeTool("tool-src-pm-1"), makeTool("tool-src-pm-2")]);
    const postmanResult = await performRestRegistration(
      body({ name: "rg3-source-postman", postman_collection: { info: {}, item: [] } }),
      undefined,
      "req-source-postman",
    );
    expect(postmanResult.body).toMatchObject({ source: "manual", tools_count: 2 });
  });

  test("manual tools[] source reports source:'manual' with the log call pinned exactly", async () => {
    const result = await performRestRegistration(
      body({ name: "rg3-source-manual", tools: [makeTool("tool-src-m1"), makeTool("tool-src-m2")] }),
      undefined,
      "req-source-manual",
    );
    expect(result.body).toMatchObject({ source: "manual", tools_count: 2 });
    expect(logSpy).toHaveBeenCalledWith("info", "Client registered", {
      name: "rg3-source-manual",
      tools_count: 2,
      source: "manual",
    });
  });
});
