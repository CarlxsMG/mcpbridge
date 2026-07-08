import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";

// Stryker mutation-testing backstop — cluster RG5a (src/mcp/registration.ts
// L510-599): the VALIDATION half of performGraphqlRegistration — the
// name/graphql_url required-field + scheme checks, the wsProxyNameCollision
// integration point unique to this branch, SSRF validation on graphql_url,
// the peerIp/ip default, and the health_url resolution logic (default to
// graphql_url + warning vs. independent SSRF re-validation of a
// caller-supplied health_url).
//
// The DISCOVERY+REGISTER half (base_url derivation, discoverToolsFromGraphQl,
// tools-count cap, tool mapping, registry.register/setToolGraphql, the
// success/error response shapes below L599) is covered by the sibling file
// registration-mutation-rg5b.test.ts — this file mocks discoverToolsFromGraphQl
// to a minimal one-tool success whenever a test needs to reach the final
// response (to observe `warnings` / the persisted health_url), so every such
// test clears rg5b's territory trivially without duplicating its assertions.
//
// `validateBackendUrl` (net/ip-validator.ts) and `discoverToolsFromGraphQl`
// (discovery/graphql-discovery.ts) are spied via `spyOn` on their module
// namespace objects rather than exercised against real DNS/network —
// registration.ts imports both as plain named imports, and this codebase
// already relies on that exact technique working for directly-imported
// functions (src/proxy/__tests__/backends.test.ts's `ipValidatorMod` spy on
// this very same `validateBackendUrl`; registration-mutation-rg5b.test.ts's
// identical pattern for `discoverToolsFromGraphQl`). Both spies default (in
// beforeEach) to a REJECTED promise with a distinctive "should not be called"
// message, so any test that doesn't explicitly queue a `mockResolvedValueOnce`
// for a given call gets a loud, easy-to-diagnose failure instead of silently
// hitting the network — this also means an unexpected EXTRA call (e.g. from a
// mutant that removes a guard and falls through further than it should) is
// itself often enough to fail the test.
//
// House convention (see src/mcp/__tests__/registry-mutation-rc*.test.ts and
// registration-mutation-rg4.test.ts): fresh in-memory SQLite + a fully
// drained live registry + a drained ws-proxy target map before every test.
// Every test/describe cites the exact surviving-mutant id(s) (line:column,
// mutator, replacement) it kills, taken from the authoritative
// reports/mutation/result.json baseline for this file (ids 416-495, the 70
// entries with status "Survived" whose location falls within L510-599).
//
// Client-name prefix: rg5a- (the sibling file uses rg5b- to avoid collision).

import { performGraphqlRegistration } from "../registration.js";
import { registry } from "../registry.js";
import { __resetDbForTesting } from "../../db/connection.js";
import { upsertWsProxyTarget, __resetWsProxyForTesting } from "../../ws-proxy.js";
import * as ipValidatorMod from "../../net/ip-validator.js";
import * as graphqlDiscoveryMod from "../../discovery/graphql-discovery.js";
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

const EXACT_NO_HEALTH_URL_WARNING =
  "No health_url provided — defaulting to graphql_url. Many GraphQL servers reject a bare GET on the operation " +
  "endpoint, which can cause false health-check failures and auto-eviction. Supply a dedicated liveness endpoint if available.";

let validateSpy: ReturnType<typeof spyOn<typeof ipValidatorMod, "validateBackendUrl">>;
let discoverSpy: ReturnType<typeof spyOn<typeof graphqlDiscoveryMod, "discoverToolsFromGraphQl">>;

async function drainRegistry(): Promise<void> {
  for (const client of registry.listClients()) {
    await registry.unregister(client.name);
  }
  __resetDbForTesting();
  __resetWsProxyForTesting();
}

beforeEach(async () => {
  await drainRegistry();
  // No test should ever reach a validateBackendUrl/discoverToolsFromGraphQl
  // call this file didn't explicitly arrange for — a real DNS-resolving
  // validateBackendUrl or a real GraphQL-introspecting discoverToolsFromGraphQl
  // would be slow/flaky/offline in a unit test. An unexpected call (e.g. a
  // mutant that removes an early-return guard and falls through further than
  // it should) rejects loudly instead of silently succeeding.
  validateSpy = spyOn(ipValidatorMod, "validateBackendUrl").mockRejectedValue(
    new Error("validateBackendUrl should not be called without an explicit mock in this test"),
  );
  discoverSpy = spyOn(graphqlDiscoveryMod, "discoverToolsFromGraphQl").mockRejectedValue(
    new Error("discoverToolsFromGraphQl should not be called without an explicit mock in this test"),
  );
});

afterEach(async () => {
  validateSpy.mockRestore();
  discoverSpy.mockRestore();
  await drainRegistry();
});

// ---------------------------------------------------------------------------
// name required-field guard — L519:7-40
//   if (typeof name !== "string" || !name) { return {...}; }
// ids: 417 ConditionalExpression->true, 418 ConditionalExpression->false,
// 419 LogicalOperator-> "&&", 421 EqualityOperator-> "===", 422 StringLiteral
// "string"->"", 423 BooleanLiteral "!name"->"name", 424 BlockStatement->"{}"
// (if-body emptied), 425/427/428 ObjectLiteral->"{}" (return shape emptied at
// various nesting levels), 426 BooleanLiteral "false"->"true" (ok flag),
// 430 StringLiteral (message)->"".
// ---------------------------------------------------------------------------

describe("performGraphqlRegistration — L519 name required-field guard", () => {
  test("a non-string TRUTHY name (123) is rejected on the typeof check alone, with the exact 400 VALIDATION_ERROR shape (kills 418,419,421,424,425,426,427,428,430)", async () => {
    const result = await performGraphqlRegistration(
      { name: 123, graphql_url: "http://good.example/gql" },
      undefined,
      "req-name-nonstring",
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.status).toBe(400);
    expect(result.body).toEqual({
      error: { code: "VALIDATION_ERROR", message: "Missing required field: name", request_id: "req-name-nonstring" },
    });
    // Never reaches the ws-collision check or beyond.
    expect(validateSpy).not.toHaveBeenCalled();
    expect(discoverSpy).not.toHaveBeenCalled();
  });

  test("an empty-string name is rejected on the falsy check, distinct from the typeof case (kills 423, re-confirms 418,424,425,426,427,428,430)", async () => {
    const result = await performGraphqlRegistration(
      { name: "", graphql_url: "http://good.example/gql" },
      undefined,
      "req-name-empty",
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.status).toBe(400);
    expect(result.body).toEqual({
      error: { code: "VALIDATION_ERROR", message: "Missing required field: name", request_id: "req-name-empty" },
    });
  });

  // The "always true" (417) and "string"->"" (422) mutants both force this
  // guard to fire even for a perfectly valid string name — killed implicitly
  // by every deep-success test below (F1-F6 etc.), all of which use a real
  // "rg5a-..." name and assert result.ok === true. If either mutant were
  // live, EVERY one of those tests would instead get "Missing required
  // field: name" and fail.
});

// ---------------------------------------------------------------------------
// wsProxyNameCollision integration — L527:7-21 `if (gqlWsCollision) return
// gqlWsCollision;` — the GraphQL-branch call site of the shared helper.
// ids: 431 ConditionalExpression->true, 432 ConditionalExpression->false.
// ---------------------------------------------------------------------------

describe("performGraphqlRegistration — L527 gqlWsCollision call site", () => {
  test("a name already registered as a ws-proxy target returns the exact 409 NAME_COLLISION outcome, before graphql_url is ever SSRF-validated (kills 432)", async () => {
    const name = "rg5a-wscollide";
    // Consumed by upsertWsProxyTarget's own internal SSRF check, not by
    // performGraphqlRegistration.
    validateSpy.mockResolvedValueOnce({ valid: true, resolvedIp: "1.2.3.4" });
    const created = await upsertWsProxyTarget(name, { backendWsUrl: "ws://127.0.0.1:9" });
    expect(created.ok).toBe(true);

    const result = await performGraphqlRegistration(
      { name, graphql_url: "http://good.example/gql" },
      undefined,
      "req-wscollide",
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.status).toBe(409);
    expect(result.body).toEqual({
      error: {
        code: "NAME_COLLISION",
        message: `"${name}" is already registered as a WS proxy target`,
        request_id: "req-wscollide",
      },
    });
    // The one call above (target setup) is the ONLY validateBackendUrl call —
    // the collision short-circuits before graphql_url's own SSRF check.
    expect(validateSpy).toHaveBeenCalledTimes(1);
    expect(discoverSpy).not.toHaveBeenCalled();
  });

  test("a non-colliding name is unaffected by the guard — proceeds to graphql_url's own SSRF check instead of a false-positive 409 (kills 431)", async () => {
    const name = "rg5a-nocollide";
    validateSpy.mockResolvedValueOnce({ valid: false, reason: "distinguishing-noncollide-reason" });

    const result = await performGraphqlRegistration(
      { name, graphql_url: "http://good.example/gql" },
      undefined,
      "req-nocollide",
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    // Must be the SSRF failure (400/VALIDATION_ERROR), NOT a wrongly-forced
    // 409/NAME_COLLISION — that would prove the "always true" mutant is live.
    expect(result.status).toBe(400);
    expect(result.body.error.code).toBe("VALIDATION_ERROR");
    expect(result.body.error.message).toBe("Invalid graphql_url: distinguishing-noncollide-reason");
  });
});

// ---------------------------------------------------------------------------
// graphql_url required-field + scheme guard — L528:7-114
//   if (typeof graphqlUrl !== "string" ||
//       (!graphqlUrl.startsWith("http://") && !graphqlUrl.startsWith("https://")))
// ids: 433/434 ConditionalExpression (whole condition) true/false, 435
// LogicalOperator (outer ||->&&), 436 ConditionalExpression (typeof clause
// alone)->false, 438 StringLiteral "string"->"", 439 ConditionalExpression
// (inner &&->false), 440 LogicalOperator (inner &&->||), 441/444 BooleanLiteral
// (dropped ! on each startsWith), 442/445 MethodExpression (startsWith-
// >endsWith for each scheme), 443/446 StringLiteral ("http://"/"https://"->""),
// 447 BlockStatement->"{}" (return emptied), 448/450/451 ObjectLiteral->"{}"
// (return shape emptied at various nesting levels), 449 BooleanLiteral
// (ok:false->true), 452 StringLiteral (message)->"".
//
// Also doubles as coverage for the graphql_url SSRF-validation-failure block
// (L543-554, ids 454-461: same idea as RG4's mcp_url SSRF block) since the
// http-only/https-only tests below deliberately fail validateBackendUrl to
// reach and pin that block's exact shape too, while simultaneously proving
// each scheme individually clears the guard above it.
// ---------------------------------------------------------------------------

describe("performGraphqlRegistration — L528 graphql_url required-field + scheme guard", () => {
  test("a non-string TRUTHY graphql_url (123) is rejected on the typeof check alone, without evaluating .startsWith on a number (kills 434,435,436)", async () => {
    const result = await performGraphqlRegistration(
      { name: "rg5a-url-nonstring", graphql_url: 123 },
      undefined,
      "req-url-nonstring",
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.status).toBe(400);
    expect(result.body.error.code).toBe("VALIDATION_ERROR");
    expect(result.body.error.message).toBe("graphql_url must start with http:// or https://");
    expect(validateSpy).not.toHaveBeenCalled();
  });

  test("a string graphql_url matching NEITHER scheme (ftp://) is rejected with the exact shape (kills 439,443,446,447,448,449,450,451,452)", async () => {
    const result = await performGraphqlRegistration(
      { name: "rg5a-url-neither", graphql_url: "ftp://evil.example" },
      undefined,
      "req-url-neither",
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.status).toBe(400);
    expect(result.body).toEqual({
      error: {
        code: "VALIDATION_ERROR",
        message: "graphql_url must start with http:// or https://",
        request_id: "req-url-neither",
      },
    });
    expect(validateSpy).not.toHaveBeenCalled();
  });

  test('an http://-only graphql_url is ACCEPTED past the scheme guard (kills 433,440,441,442) and reaches its OWN SSRF check with the exact "Invalid graphql_url" shape (kills 454,455,457,458,459,460,461)', async () => {
    validateSpy.mockResolvedValueOnce({ valid: false, reason: "http-only-blocked-reason" });

    const result = await performGraphqlRegistration(
      { name: "rg5a-url-http-only", graphql_url: "http://good.example/gql" },
      undefined,
      "req-url-http-only",
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.status).toBe(400);
    expect(result.body).toEqual({
      error: {
        code: "VALIDATION_ERROR",
        message: "Invalid graphql_url: http-only-blocked-reason",
        request_id: "req-url-http-only",
      },
    });
    expect(validateSpy).toHaveBeenCalledTimes(1);
    expect(validateSpy.mock.calls[0]![0]).toBe("http://good.example/gql");
  });

  test('an https://-only graphql_url is ACCEPTED past the scheme guard (mirror of http case, kills 433,440,444,445) and reaches its OWN SSRF check (kills 456 "always false" pairing)', async () => {
    validateSpy.mockResolvedValueOnce({ valid: false, reason: "https-only-blocked-reason" });

    const result = await performGraphqlRegistration(
      { name: "rg5a-url-https-only", graphql_url: "https://good.example/gql" },
      undefined,
      "req-url-https-only",
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.status).toBe(400);
    expect(result.body).toEqual({
      error: {
        code: "VALIDATION_ERROR",
        message: "Invalid graphql_url: https-only-blocked-reason",
        request_id: "req-url-https-only",
      },
    });
    expect(validateSpy).toHaveBeenCalledTimes(1);
    expect(validateSpy.mock.calls[0]![0]).toBe("https://good.example/gql");
  });

  // id438 (StringLiteral "string"->"" on the typeof clause) and id455
  // (ConditionalExpression "always true" on the SSRF-invalid check) both
  // force an always-fire on a guard that should NOT fire for a legitimate,
  // successfully-validated URL — killed implicitly by every deep-success
  // test below (F1-F6), which all use real http(s):// graphql_urls and a
  // validateBackendUrl mock that resolves `valid: true`.
});

// ---------------------------------------------------------------------------
// Deep success-path cluster: health_url resolution (L567-593) + the
// peerIp/ip default (L557) + the warnings-init/spread interplay (L567).
//
// Every test in this cluster reaches a genuine successful registration
// (mocking discoverToolsFromGraphQl to a single minimal tool and letting
// registry.register/setToolGraphql run for real), so persisted state can be
// inspected via registry.getClientDetail(...) exactly like the deep tests in
// registration-mutation-rg4.test.ts / rg5b.test.ts do.
// ---------------------------------------------------------------------------

describe('performGraphqlRegistration — L557 peerIp||"127.0.0.1" + L567-593 health_url resolution', () => {
  // L569:7-61 `if (typeof body.health_url === "string" && body.health_url)`
  // ids: 469 ConditionalExpression->true, 475 BlockStatement->"{}" (if-body
  // emptied), 493 BlockStatement->"{}" (else-body emptied), 495 StringLiteral
  // (warning message)->"".
  test("NO health_url in body at all -> defaults resolvedHealthUrl to EXACTLY graphql_url, pushes the exact fallback warning, and calls validateBackendUrl only ONCE (kills 469,475,493,495)", async () => {
    const name = "rg5a-nohealth";
    const graphqlUrl = "http://good.example/gql";
    validateSpy.mockResolvedValueOnce({ valid: true, resolvedIp: "93.184.216.34" });
    discoverSpy.mockResolvedValueOnce([makeDiscovered()]);

    const result = await performGraphqlRegistration({ name, graphql_url: graphqlUrl }, undefined, "req-nohealth");

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.body.warnings).toEqual([EXACT_NO_HEALTH_URL_WARNING]);
    expect(registry.getClientDetail(name)?.healthUrl).toBe(graphqlUrl);
    expect(validateSpy).toHaveBeenCalledTimes(1);
  });

  // L569:7-61 LogicalOperator (&&->||), L569:7-42 EqualityOperator/
  // ConditionalExpression on the typeof sub-clause. ids: 471 (&&->||), 472
  // (typeof-clause forced true), 473 (typeof-clause !== instead of ===), 474
  // (typeof "string"->""). Empirically verified via a standalone `bun -e`
  // truth-table (real vs. each mutant, over undefined/""/123/"/healthz")
  // before writing these three tests: for hu="", ONLY 471 diverges from real
  // (472/473/474 all coincide with real's `false` here) — 474 specifically
  // only diverges for a GENUINE non-empty string health_url, which is what
  // the relative-health_url tests (F3/F4) below exercise and assert instead.
  test('an EMPTY-STRING health_url ("") is falsy -> ALSO takes the else-branch (proves the guard needs BOTH the typeof check AND truthiness, not just one) (kills 471)', async () => {
    const name = "rg5a-emptyhealth";
    const graphqlUrl = "http://good.example/gql";
    validateSpy.mockResolvedValueOnce({ valid: true, resolvedIp: "93.184.216.34" });
    discoverSpy.mockResolvedValueOnce([makeDiscovered()]);

    const result = await performGraphqlRegistration(
      { name, graphql_url: graphqlUrl, health_url: "" },
      undefined,
      "req-emptyhealth",
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.body.warnings).toEqual([EXACT_NO_HEALTH_URL_WARNING]);
    expect(registry.getClientDetail(name)?.healthUrl).toBe(graphqlUrl);
    // Under the &&->|| mutant, "" is truthy-enough-via-OR to wrongly enter
    // the if-branch, which would call validateBackendUrl a SECOND time.
    expect(validateSpy).toHaveBeenCalledTimes(1);
  });

  test("a non-string TRUTHY health_url (123) is rejected by the typeof check alone -> ALSO takes the else-branch, not a crash from calling .startsWith on a number (kills 472,473)", async () => {
    const name = "rg5a-numhealth";
    const graphqlUrl = "http://good.example/gql";
    validateSpy.mockResolvedValueOnce({ valid: true, resolvedIp: "93.184.216.34" });
    discoverSpy.mockResolvedValueOnce([makeDiscovered()]);

    const result = await performGraphqlRegistration(
      { name, graphql_url: graphqlUrl, health_url: 123 },
      undefined,
      "req-numhealth",
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.body.warnings).toEqual([EXACT_NO_HEALTH_URL_WARNING]);
    expect(registry.getClientDetail(name)?.healthUrl).toBe(graphqlUrl);
    expect(validateSpy).toHaveBeenCalledTimes(1);
  });

  // L557:14-35 `const ip = peerIp || "127.0.0.1";` ids: 464/465
  // ConditionalExpression true/false, 466 LogicalOperator (||->&&), 467
  // StringLiteral ("127.0.0.1"->"").
  // L571-573 relative-URL construction ternary/template. ids: 476
  // MethodExpression (startsWith->endsWith, absolute check — see the F5 test
  // below), 478 StringLiteral (whole template->``), 479 MethodExpression
  // (startsWith->endsWith, slash check), 480/481/482 StringLiteral (the ""/"/"
  // slash-insertion literals).
  test("a relative health_url that ALREADY has a leading '/' is resolved against the DEFAULT ip (peerIp undefined -> 127.0.0.1) with NO extra slash inserted (kills 464,466,467,473,474,478,479,480,481,482 [leading-slash-present variant])", async () => {
    const name = "rg5a-relslash";
    const graphqlUrl = "http://good.example/gql";
    validateSpy.mockResolvedValueOnce({ valid: true, resolvedIp: "93.184.216.34" }); // graphql_url
    validateSpy.mockResolvedValueOnce({ valid: true, resolvedIp: "9.9.9.9" }); // health_url
    discoverSpy.mockResolvedValueOnce([makeDiscovered()]);

    const result = await performGraphqlRegistration(
      { name, graphql_url: graphqlUrl, health_url: "/healthz" },
      undefined,
      "req-relslash",
    );

    expect(result.ok).toBe(true);
    expect(validateSpy).toHaveBeenCalledTimes(2);
    expect(validateSpy.mock.calls[1]![0]).toBe("http://127.0.0.1/healthz");
    expect(registry.getClientDetail(name)?.healthUrl).toBe("http://127.0.0.1/healthz");
  });

  test("a relative health_url WITHOUT a leading '/' gets EXACTLY one '/' inserted, resolved against the REAL peerIp (not the 127.0.0.1 default) (kills 465,466,473,474,479,480,481,482 [no-leading-slash variant])", async () => {
    const name = "rg5a-relnoslash";
    const graphqlUrl = "http://good.example/gql";
    validateSpy.mockResolvedValueOnce({ valid: true, resolvedIp: "93.184.216.34" });
    validateSpy.mockResolvedValueOnce({ valid: true, resolvedIp: "9.9.9.9" });
    discoverSpy.mockResolvedValueOnce([makeDiscovered()]);

    const result = await performGraphqlRegistration(
      { name, graphql_url: graphqlUrl, health_url: "healthz" },
      "10.20.30.40",
      "req-relnoslash",
    );

    expect(result.ok).toBe(true);
    expect(validateSpy).toHaveBeenCalledTimes(2);
    expect(validateSpy.mock.calls[1]![0]).toBe("http://10.20.30.40/healthz");
    expect(registry.getClientDetail(name)?.healthUrl).toBe("http://10.20.30.40/healthz");
  });

  test("an ABSOLUTE health_url (already starts with 'http') passes through to validation UNCHANGED, and a real health_url produces NO warning (the 'warnings' key is absent, not an empty array) (kills 476, 468)", async () => {
    const name = "rg5a-abshealth";
    const graphqlUrl = "http://good.example/gql";
    const absHealth = "https://health.example.com:9443/status";
    validateSpy.mockResolvedValueOnce({ valid: true, resolvedIp: "93.184.216.34" });
    validateSpy.mockResolvedValueOnce({ valid: true, resolvedIp: "9.9.9.9" });
    discoverSpy.mockResolvedValueOnce([makeDiscovered()]);

    const result = await performGraphqlRegistration(
      { name, graphql_url: graphqlUrl, health_url: absHealth },
      "10.20.30.40",
      "req-abshealth",
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(validateSpy).toHaveBeenCalledTimes(2);
    // Passed through byte-for-byte -- NOT re-wrapped with the ip/slash template.
    expect(validateSpy.mock.calls[1]![0]).toBe(absHealth);
    expect(registry.getClientDetail(name)?.healthUrl).toBe(absHealth);
    // id468 (warnings: string[] = [] -> ["Stryker was here"]): the spread
    // `...(warnings.length ? { warnings } : {})` only matters observably
    // once we reach a real success response with a health_url actually
    // provided (no push ever happens) -- the key must be MISSING entirely,
    // not present with a poisoned/empty array.
    expect(result.body).not.toHaveProperty("warnings");
    expect(Object.keys(result.body)).not.toContain("warnings");
    expect(result.body).toEqual({ status: "registered", name, tools_count: 1, source: "graphql" });
  });

  // L575:9-32 `if (!healthValidation.valid)` -- the health_url's OWN,
  // independent SSRF check (distinct from graphql_url's own check above).
  // ids: 483 BooleanLiteral (dropped !), 484/485 ConditionalExpression
  // true/false, 486 BlockStatement->"{}" (return emptied), 487/489/490
  // ObjectLiteral->"{}" (return shape emptied at various nesting levels), 491
  // StringLiteral (code)->"", 492 StringLiteral (message template)->``.
  test("health_url's OWN SSRF validation failure is independent from graphql_url's -- exact 'Invalid health_url: <reason>' shape, proven distinct by graphql_url succeeding while health_url fails (kills 483,484,486,487,489,490,491,492)", async () => {
    const name = "rg5a-healthssrf";
    const graphqlUrl = "http://good.example/gql";
    validateSpy.mockResolvedValueOnce({ valid: true, resolvedIp: "93.184.216.34" }); // graphql_url succeeds
    validateSpy.mockResolvedValueOnce({ valid: false, reason: "health-url-blocked-reason" }); // health_url fails

    const result = await performGraphqlRegistration(
      { name, graphql_url: graphqlUrl, health_url: "http://blocked.internal/health" },
      undefined,
      "req-healthssrf",
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.status).toBe(400);
    expect(result.body).toEqual({
      error: {
        code: "VALIDATION_ERROR",
        message: "Invalid health_url: health-url-blocked-reason",
        request_id: "req-healthssrf",
      },
    });
    expect(validateSpy).toHaveBeenCalledTimes(2);
    // Never reaches discovery/registration.
    expect(discoverSpy).not.toHaveBeenCalled();
    expect(registry.getClientDetail(name)).toBeUndefined();
  });

  // id484 ("always true", health_url error fires even when valid) is killed
  // implicitly by the relative/absolute health_url tests above, all of which
  // mock healthValidation as `valid: true` and assert a SUCCESSFUL outcome
  // reaching registry.getClientDetail -- under an always-true mutant every one
  // of those would instead get the "Invalid health_url" error and fail.
});
