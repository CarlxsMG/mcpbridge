import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";

// Stryker mutation-testing backstop — cluster RG5b (src/mcp/registration.ts
// L600-667): the DISCOVERY+REGISTER half of performGraphqlRegistration —
// base_url derivation from the parsed graphql_url, GraphQL introspection via
// discoverToolsFromGraphQl, the tools-count cap check, mapping discovered
// GraphQL operations into REST-shaped tools, registry.register(...), per-tool
// setToolGraphql(...) persistence, and the success/error response shapes.
//
// The VALIDATION half (name/graphql_url shape checks, wsProxyNameCollision,
// validateBackendUrl SSRF gate, health_url resolution/warning) is covered by
// the sibling file registration-mutation-rg5a.test.ts — this file mocks
// validateBackendUrl to always succeed so every test here clears that
// gauntlet trivially and reaches the discovery/register code under test.
//
// House convention (see src/mcp/__tests__/registry-mutation-rc9.test.ts):
// fresh in-memory SQLite + a fully drained live registry before every test
// (unregister() only tears down in-memory state, so __resetDbForTesting() is
// still required to avoid leaking persisted rows across tests reusing
// generic names). Client names in this file are prefixed "rg5b-" to avoid
// any collision with the sibling's "rg5a-" fixtures.

import { performGraphqlRegistration } from "../registration.js";
import { registry } from "../registry.js";
import { __resetDbForTesting } from "../../db/connection.js";
import { config } from "../../config.js";
import * as graphqlDiscoveryMod from "../../discovery/graphql-discovery.js";
import * as upstreamAuthMod from "../../backend-auth/upstream-auth.js";
import * as ipValidatorMod from "../../net/ip-validator.js";
import * as backendsMod from "../../proxy/backends.js";
import * as loggerMod from "../../logger.js";
import type { GraphqlDiscoveredTool } from "../../discovery/graphql-discovery.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDiscovered(overrides: Partial<GraphqlDiscoveredTool> = {}): GraphqlDiscoveredTool {
  return {
    name: "hello",
    description: "Say hello",
    inputSchema: { type: "object", properties: {}, required: [] },
    query: "query hello { hello }",
    ...overrides,
  };
}

function makeBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "rg5b-default",
    graphql_url: "http://example.com:8080/api/graphql",
    ...overrides,
  };
}

const originalMaxTools = config.maxToolsPerClient;

let validateSpy: ReturnType<typeof spyOn<typeof ipValidatorMod, "validateBackendUrl">>;
let authHeadersSpy: ReturnType<typeof spyOn<typeof upstreamAuthMod, "getUpstreamAuthHeaders">>;
let setGraphqlSpy: ReturnType<typeof spyOn<typeof backendsMod, "setToolGraphql">>;
let discoverSpy: ReturnType<typeof spyOn<typeof graphqlDiscoveryMod, "discoverToolsFromGraphQl">>;

beforeEach(async () => {
  for (const client of registry.listClients()) {
    await registry.unregister(client.name);
  }
  __resetDbForTesting();
  (config as Record<string, unknown>).maxToolsPerClient = originalMaxTools;

  // Always clears the validation gauntlet (sibling's coverage territory) so
  // every test here reaches the discovery/register code under test. Real
  // resolvedIp value is irrelevant to this file's assertions.
  validateSpy = spyOn(ipValidatorMod, "validateBackendUrl").mockResolvedValue({
    valid: true,
    resolvedIp: "93.184.216.34",
  });
  // Default: no upstream auth configured for the client under test. Individual
  // tests may override with mockReturnValue for a non-null case if needed.
  authHeadersSpy = spyOn(upstreamAuthMod, "getUpstreamAuthHeaders").mockReturnValue(null);
  // Spies but calls through to the real implementation (default bun:test
  // spyOn behavior) so registry-side persistence still actually happens and
  // can be asserted on via registry.getClientDetail(...).
  setGraphqlSpy = spyOn(backendsMod, "setToolGraphql");
});

afterEach(() => {
  validateSpy.mockRestore();
  authHeadersSpy.mockRestore();
  setGraphqlSpy.mockRestore();
  discoverSpy?.mockRestore();
  (config as Record<string, unknown>).maxToolsPerClient = originalMaxTools;
});

// ---------------------------------------------------------------------------
// L602:7 / L603:55 — resolvedBaseUrl = `${protocol}//${host}` (port kept, path stripped)
// ---------------------------------------------------------------------------

describe("performGraphqlRegistration — resolvedBaseUrl derivation (L602/L603)", () => {
  test("a graphql_url with a non-default port AND a path registers base_url as EXACTLY protocol+host, port included, path stripped", async () => {
    discoverSpy = spyOn(graphqlDiscoveryMod, "discoverToolsFromGraphQl").mockResolvedValue([makeDiscovered()]);

    const result = await performGraphqlRegistration(
      makeBody({ name: "rg5b-baseurl", graphql_url: "http://example.com:8080/api/graphql" }),
      "10.0.0.5",
      "req-baseurl",
    );

    expect(result.ok).toBe(true);
    const detail = registry.getClientDetail("rg5b-baseurl");
    expect(detail).toBeDefined();
    // Exact match -- kills both the StringLiteral/TemplateLiteral scrambling of
    // the template AND a BlockStatement-style "parse once, reuse" mutation:
    // wrong output here would be e.g. "http://example.com:8080/api/graphql"
    // (path not stripped) or "http://example.com" (port dropped).
    expect(detail!.baseUrl).toBe("http://example.com:8080");
  });
});

// ---------------------------------------------------------------------------
// L606:20 — authHeaders: getUpstreamAuthHeaders(name) ?? undefined
// ---------------------------------------------------------------------------

describe("performGraphqlRegistration — authHeaders nullish-coalescing (L606)", () => {
  test("no upstream auth configured -> discoverToolsFromGraphQl receives authHeaders: undefined, NOT null", async () => {
    authHeadersSpy.mockReturnValue(null);
    discoverSpy = spyOn(graphqlDiscoveryMod, "discoverToolsFromGraphQl").mockResolvedValue([makeDiscovered()]);

    const result = await performGraphqlRegistration(makeBody({ name: "rg5b-authheaders" }), undefined, "req-auth");

    expect(result.ok).toBe(true);
    expect(discoverSpy).toHaveBeenCalledTimes(1);
    const callArg = discoverSpy.mock.calls[0]![0] as { authHeaders?: Record<string, string> };
    // A LogicalOperator mutant that drops the "?? undefined" fallback (or
    // swaps ?? for something that passes through null) would fail this --
    // `toBeUndefined()` is strict and null !== undefined.
    expect(callArg.authHeaders).toBeUndefined();
    expect(callArg.authHeaders).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// L609/L610 — zero discovered tools -> DISCOVERY_ERROR, exact message
// ---------------------------------------------------------------------------

describe("performGraphqlRegistration — zero tools discovered (L609/L610)", () => {
  test("an empty discovery result is rejected with the exact DISCOVERY_ERROR shape", async () => {
    discoverSpy = spyOn(graphqlDiscoveryMod, "discoverToolsFromGraphQl").mockResolvedValue([]);

    const result = await performGraphqlRegistration(makeBody({ name: "rg5b-empty" }), undefined, "req-empty");

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.status).toBe(400);
    expect(result.body.error.code).toBe("DISCOVERY_ERROR");
    expect(result.body.error.message).toBe("No tools discovered from GraphQL endpoint");
    expect(result.body.error.request_id).toBe("req-empty");
    // Nothing should have been registered. getClientDetail returns undefined
    // (not null) for an unknown client.
    expect(registry.getClientDetail("rg5b-empty")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// L614-621 / L622-629 — tools-count cap check, boundary + exact error shape
// ---------------------------------------------------------------------------

describe("performGraphqlRegistration — maxToolsPerClient cap (L614-629)", () => {
  test("discovered.length exactly AT the cap succeeds (boundary is '>' not '>=')", async () => {
    (config as Record<string, unknown>).maxToolsPerClient = 2;
    discoverSpy = spyOn(graphqlDiscoveryMod, "discoverToolsFromGraphQl").mockResolvedValue([
      makeDiscovered({ name: "op_one", query: "query op_one { opOne }" }),
      makeDiscovered({ name: "op_two", query: "query op_two { opTwo }" }),
    ]);

    const result = await performGraphqlRegistration(makeBody({ name: "rg5b-cap-exact" }), undefined, "req-cap-exact");

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.body.tools_count).toBe(2);
  });

  test("discovered.length ONE OVER the cap is rejected with the exact VALIDATION_ERROR shape", async () => {
    (config as Record<string, unknown>).maxToolsPerClient = 2;
    discoverSpy = spyOn(graphqlDiscoveryMod, "discoverToolsFromGraphQl").mockResolvedValue([
      makeDiscovered({ name: "op_one", query: "query op_one { opOne }" }),
      makeDiscovered({ name: "op_two", query: "query op_two { opTwo }" }),
      makeDiscovered({ name: "op_three", query: "query op_three { opThree }" }),
    ]);

    const result = await performGraphqlRegistration(makeBody({ name: "rg5b-cap-over" }), undefined, "req-cap-over");

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.status).toBe(400);
    // Exact object shape -- code, message (with both interpolated numbers,
    // in the right order), and request_id all asserted individually so a
    // StringLiteral/ObjectLiteral/template-arg-swap mutant on any one field
    // is caught.
    expect(result.body.error.code).toBe("VALIDATION_ERROR");
    expect(result.body.error.message).toBe("GraphQL schema exposes 3 tools, exceeds maximum of 2");
    expect(result.body.error.request_id).toBe("req-cap-over");
    // Rejected before registration -- nothing persisted.
    expect(registry.getClientDetail("rg5b-cap-over")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// L636 — endpointPath = parsedGraphqlUrl.pathname || "/graphql"
// ---------------------------------------------------------------------------

describe("performGraphqlRegistration — endpointPath derivation (L636)", () => {
  // Empirically, `new URL(...).pathname` is NEVER falsy for a valid parsed
  // URL -- a bare origin like "http://x.com" already yields pathname "/",
  // never "". That makes the `|| "/graphql"` fallback text itself dead code:
  // no graphql_url that passes the http(s):// prefix + validateBackendUrl
  // gauntlet earlier in this function can ever produce a falsy pathname, so
  // a StringLiteral mutant on the "/graphql" fallback (e.g. "" or "/x") is
  // EQUIVALENT -- there is no reachable input that observes it. Documented
  // here rather than chased with a test.
  //
  // The LogicalOperator mutant (|| -> &&) is NOT equivalent, though: since
  // pathname is always truthy, `pathname && "/graphql"` would ALWAYS
  // evaluate to the literal "/graphql", discarding the real path on every
  // call. That IS observable and killed below.
  test("a graphql_url with a real path uses that exact pathname as the tool endpoint, not a hardcoded '/graphql'", async () => {
    discoverSpy = spyOn(graphqlDiscoveryMod, "discoverToolsFromGraphQl").mockResolvedValue([makeDiscovered()]);

    const result = await performGraphqlRegistration(
      makeBody({ name: "rg5b-endpointpath", graphql_url: "http://example.com/api/v2/gql" }),
      undefined,
      "req-endpointpath",
    );

    expect(result.ok).toBe(true);
    const detail = registry.getClientDetail("rg5b-endpointpath");
    expect(detail!.tools).toHaveLength(1);
    // Kills the || -> && LogicalOperator mutant: under that mutant every
    // registration would get endpoint "/graphql" regardless of the real path.
    expect(detail!.tools[0]!.endpoint).toBe("/api/v2/gql");
  });
});

// ---------------------------------------------------------------------------
// L637:40 — the discovered.map(...) callback body (ArrowFunction -> undefined)
// ---------------------------------------------------------------------------

describe("performGraphqlRegistration — discovered -> REST-shaped tool mapping (L637)", () => {
  test("all five mapped fields (name, method, endpoint, description, inputSchema) are populated correctly, not emptied", async () => {
    const discovered = makeDiscovered({
      name: "get_widget",
      description: "Fetch a widget by id",
      inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      query: "query get_widget($id: ID!) { widget(id: $id) { id } }",
    });
    discoverSpy = spyOn(graphqlDiscoveryMod, "discoverToolsFromGraphQl").mockResolvedValue([discovered]);

    const result = await performGraphqlRegistration(
      makeBody({ name: "rg5b-maptool", graphql_url: "http://example.com/gql-endpoint" }),
      undefined,
      "req-maptool",
    );

    expect(result.ok).toBe(true);
    const tool = registry.getClientDetail("rg5b-maptool")!.tools[0]!;
    // An emptied map callback (() => undefined) would make registry.register
    // throw on the very first tool ("Tool name is required..."), so simply
    // reaching a 1-tool successful registration already partially kills it --
    // but assert every field explicitly for a precise, self-documenting test.
    expect(tool.name).toBe("get_widget");
    expect(tool.method).toBe("POST");
    expect(tool.endpoint).toBe("/gql-endpoint");
    expect(tool.description).toBe("Fetch a widget by id");
    expect(tool.inputSchema).toEqual({ type: "object", properties: { id: { type: "string" } }, required: ["id"] });
  });
});

// ---------------------------------------------------------------------------
// L645:98 — registry.register(..., false) hardcoded retry_non_safe_methods
// ---------------------------------------------------------------------------

describe("performGraphqlRegistration — retry_non_safe_methods is always hardcoded false (L645)", () => {
  test("a request body trying to set retry_non_safe_methods: true is silently ignored -- registered client keeps it false", async () => {
    discoverSpy = spyOn(graphqlDiscoveryMod, "discoverToolsFromGraphQl").mockResolvedValue([makeDiscovered()]);

    const result = await performGraphqlRegistration(
      makeBody({ name: "rg5b-retryflag", retry_non_safe_methods: true }),
      undefined,
      "req-retryflag",
    );

    expect(result.ok).toBe(true);
    const detail = registry.getClientDetail("rg5b-retryflag");
    // BooleanLiteral mutant (false -> true) would flip this. This also
    // proves the function doesn't even read body.retry_non_safe_methods --
    // the field is fully ignored on this path.
    expect(detail!.retryNonSafeMethods).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// L647 — setToolGraphql(name, d.name, { enabled: true, query: d.query }) per discovered op
// ---------------------------------------------------------------------------

describe("performGraphqlRegistration — per-tool setToolGraphql persistence (L647)", () => {
  test("called once per discovered operation, each with enabled:true and that operation's own query", async () => {
    const discovered = [
      makeDiscovered({ name: "op_alpha", query: "query op_alpha { alpha }" }),
      makeDiscovered({ name: "op_beta", query: "mutation op_beta { beta }" }),
    ];
    discoverSpy = spyOn(graphqlDiscoveryMod, "discoverToolsFromGraphQl").mockResolvedValue(discovered);

    const result = await performGraphqlRegistration(makeBody({ name: "rg5b-setgql" }), undefined, "req-setgql");

    expect(result.ok).toBe(true);
    expect(setGraphqlSpy).toHaveBeenCalledTimes(2);
    expect(setGraphqlSpy).toHaveBeenNthCalledWith(1, "rg5b-setgql", "op_alpha", {
      enabled: true,
      query: "query op_alpha { alpha }",
    });
    expect(setGraphqlSpy).toHaveBeenNthCalledWith(2, "rg5b-setgql", "op_beta", {
      enabled: true,
      query: "mutation op_beta { beta }",
    });

    // Real persistence (spy calls through) -- confirm it actually landed,
    // which also kills an ObjectLiteral mutant on `enabled: true` (-> false)
    // since getGraphqlForClient reflects the real stored row.
    const detail = registry.getClientDetail("rg5b-setgql")!;
    const alpha = detail.tools.find((t) => t.name === "op_alpha");
    expect(alpha?.graphql).toEqual({ enabled: true, query: "query op_alpha { alpha }" });
  });
});

// ---------------------------------------------------------------------------
// L650-666 — catch block (DISCOVERY_ERROR) + success response's conditional warnings spread
// ---------------------------------------------------------------------------

describe("performGraphqlRegistration — catch block always reports DISCOVERY_ERROR (L650-653)", () => {
  test("a thrown error from discoverToolsFromGraphQl surfaces as a 400 DISCOVERY_ERROR with the thrown message", async () => {
    discoverSpy = spyOn(graphqlDiscoveryMod, "discoverToolsFromGraphQl").mockRejectedValue(
      new Error("upstream introspection failed: connection reset"),
    );

    const result = await performGraphqlRegistration(makeBody({ name: "rg5b-catcherr" }), undefined, "req-catcherr");

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.status).toBe(400);
    expect(result.body.error.code).toBe("DISCOVERY_ERROR");
    expect(result.body.error.message).toBe("upstream introspection failed: connection reset");
    expect(result.body.error.request_id).toBe("req-catcherr");
    expect(registry.getClientDetail("rg5b-catcherr")).toBeUndefined();
  });
});

describe("performGraphqlRegistration — success response's conditional warnings spread (L656-666)", () => {
  test("health_url provided -> no warning generated -> the 'warnings' key is ABSENT from the body entirely (not an empty array)", async () => {
    discoverSpy = spyOn(graphqlDiscoveryMod, "discoverToolsFromGraphQl").mockResolvedValue([makeDiscovered()]);

    const result = await performGraphqlRegistration(
      makeBody({ name: "rg5b-nowarn", health_url: "http://example.com:8080/healthz" }),
      undefined,
      "req-nowarn",
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    // The spread-conditional (`...(warnings.length ? { warnings } : {})`)
    // means the key itself must be missing -- not present-with-[] -- when
    // there are zero warnings. A ConditionalExpression mutant that forces
    // the spread branch to always apply would add `warnings: []` here.
    expect(Object.keys(result.body)).not.toContain("warnings");
    expect(result.body).not.toHaveProperty("warnings");
    expect(result.body).toEqual({
      status: "registered",
      name: "rg5b-nowarn",
      tools_count: 1,
      source: "graphql",
    });
  });

  test("health_url omitted -> a warning IS generated -> the body's 'warnings' key is present as a non-empty array", async () => {
    discoverSpy = spyOn(graphqlDiscoveryMod, "discoverToolsFromGraphQl").mockResolvedValue([makeDiscovered()]);

    const result = await performGraphqlRegistration(makeBody({ name: "rg5b-haswarn" }), undefined, "req-haswarn");

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.body).toHaveProperty("warnings");
    expect(Array.isArray(result.body.warnings)).toBe(true);
    expect(result.body.warnings!.length).toBeGreaterThan(0);
    expect(result.body.status).toBe("registered");
    expect(result.body.name).toBe("rg5b-haswarn");
    expect(result.body.tools_count).toBe(1);
    expect(result.body.source).toBe("graphql");
  });
});

// ---------------------------------------------------------------------------
// L603:55 / L605:14 — the discoverToolsFromGraphQl(...) options object and its
// nested ipPin object (both ObjectLiteral -> '{}'). L606's authHeaders field
// is already pinned above; this closes the other three fields.
// ---------------------------------------------------------------------------

describe("performGraphqlRegistration — full discoverToolsFromGraphQl options shape (L603/L605)", () => {
  test("graphqlUrl and ipPin (resolvedIp + hostname) are passed through exactly", async () => {
    discoverSpy = spyOn(graphqlDiscoveryMod, "discoverToolsFromGraphQl").mockResolvedValue([makeDiscovered()]);

    await performGraphqlRegistration(
      makeBody({ name: "rg5b-optshape", graphql_url: "http://gql.example.com:9090/v1/gql" }),
      undefined,
      "req-optshape",
    );

    expect(discoverSpy).toHaveBeenCalledTimes(1);
    const callArgs = discoverSpy.mock.calls[0]![0];
    // An emptied outer ObjectLiteral (L603:55 -> '{}') would call
    // discoverToolsFromGraphQl() with no arguments at all; an emptied inner
    // ipPin object (L605:14 -> '{}') would strip resolvedIp/hostname.
    expect(callArgs.graphqlUrl).toBe("http://gql.example.com:9090/v1/gql");
    expect(callArgs.ipPin).toEqual({ resolvedIp: "93.184.216.34", hostname: "gql.example.com" });
  });
});

// ---------------------------------------------------------------------------
// L607:25 (ConditionalExpression x2) / L607:52 (BooleanLiteral) —
// `includeMutations: body.include_mutations !== false`.
// ---------------------------------------------------------------------------

describe("performGraphqlRegistration — includeMutations opt-out (L607)", () => {
  test("include_mutations omitted defaults to includeMutations: true", async () => {
    discoverSpy = spyOn(graphqlDiscoveryMod, "discoverToolsFromGraphQl").mockResolvedValue([makeDiscovered()]);
    await performGraphqlRegistration(makeBody({ name: "rg5b-incmut-default" }), undefined, "req-incmut-default");
    expect(discoverSpy.mock.calls[0]![0].includeMutations).toBe(true);
  });

  test("include_mutations: false -> includeMutations: false (the only value that opts out)", async () => {
    discoverSpy = spyOn(graphqlDiscoveryMod, "discoverToolsFromGraphQl").mockResolvedValue([makeDiscovered()]);
    await performGraphqlRegistration(
      makeBody({ name: "rg5b-incmut-false", include_mutations: false }),
      undefined,
      "req-incmut-false",
    );
    expect(discoverSpy.mock.calls[0]![0].includeMutations).toBe(false);
  });

  test("include_mutations: true -> includeMutations: true (kills a forced-constant BooleanLiteral mutant)", async () => {
    discoverSpy = spyOn(graphqlDiscoveryMod, "discoverToolsFromGraphQl").mockResolvedValue([makeDiscovered()]);
    await performGraphqlRegistration(
      makeBody({ name: "rg5b-incmut-true", include_mutations: true }),
      undefined,
      "req-incmut-true",
    );
    expect(discoverSpy.mock.calls[0]![0].includeMutations).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// L655:15/46/87 — log("info", "GraphQL endpoint registered", {name,
// tools_count, source:"graphql"}) — three StringLiterals on the success log
// call, distinct from the return statement's own "graphql"/"registered"
// literals already pinned by the response-shape tests above.
// ---------------------------------------------------------------------------

describe("performGraphqlRegistration — success log call (L655)", () => {
  test("logs level 'info', the exact message, and the full meta object", async () => {
    const logSpy = spyOn(loggerMod, "log").mockImplementation(() => {});
    try {
      discoverSpy = spyOn(graphqlDiscoveryMod, "discoverToolsFromGraphQl").mockResolvedValue([
        makeDiscovered({ name: "widget_get" }),
      ]);

      await performGraphqlRegistration(makeBody({ name: "rg5b-logcall" }), undefined, "req-logcall");

      const call = logSpy.mock.calls.find((c) => c[1] === "GraphQL endpoint registered");
      expect(call).toBeDefined();
      expect(call![0]).toBe("info");
      expect(call![2]).toEqual({ name: "rg5b-logcall", tools_count: 1, source: "graphql" });
    } finally {
      logSpy.mockRestore();
    }
  });
});
