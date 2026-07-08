/**
 * Mutation-testing backstop — RG2 (src/mcp/registration.ts L150-278,
 * performRestRegistration's VALIDATION GAUNTLET): required-field checks
 * (name, health_url — L169), the "exactly one discovery source" check
 * (tools/openapi_url/curl_input/postman_collection — L184-212), the
 * peer-IP-required-for-relative-health_url check (L216-229), health_url
 * resolution + SSRF validation (L232-244), and base_url resolution + SSRF
 * validation (L249-277). Each describe block cites the exact line range,
 * mutator, and replacement it targets, per the house convention established
 * across the P2/PX/registry-mutation-rc series (see stryker.config.mjs's
 * SCOPE HISTORY). Line numbers below were re-verified against the current
 * source by direct read + grep before writing any test (the numbers handed
 * down in the task brief drifted slightly from the live file; these are the
 * corrected ones).
 *
 * `performRestRegistration` is called directly (no Express) — this is a pure
 * function. Every guard in this file's scope returns BEFORE
 * `registry.register()` is ever reached, with exactly one exception: the
 * "proceeds past this guard" tests need a way to observe forward progress
 * without actually completing a registration. Two techniques are used for
 * that, chosen per guard:
 *
 *   1. Chain to the NEXT guard's distinct error message (for the early,
 *      synchronous guards — required-fields, discovery-source count — which
 *      never touch validateBackendUrl at all).
 *   2. `validateBackendUrl` (imported from ../../net/ip-validator.js) is
 *      spied via `spyOn` for full control with zero real DNS/network
 *      involvement. For guards downstream of BOTH SSRF calls (base_url
 *      resolution, L249-277), "proceeds" is proven via a MARKER: set
 *      `tools` to a non-array truthy value (still satisfies the
 *      "exactly one discovery source" count, since only undefined/null
 *      make hasTools false) so that once both SSRF validations report
 *      valid:true, the very next line of registration.ts — the
 *      `if (!Array.isArray(tools))` check at ~L329-334, immediately after
 *      this file's assigned range and covered by a sibling file (rg3), not
 *      claimed here — fires a distinctive, unambiguous
 *      "'tools' must be an array" error. Reaching that exact message is
 *      only possible if every earlier guard in this file's range passed.
 *
 * No test in this file reaches `registry.register()`, so no DB/registry
 * cleanup of registered clients is needed. `__resetDbForTesting()` is still
 * called in `beforeEach` purely so the ws-proxy-name-collision helper (which
 * does one real DB read on every call, before any of the guards in this
 * file's range) never touches the real on-disk `data/mcp-bridge.db` file if
 * this happens to be the first test in the whole `bun run test` process to
 * touch persistence — cheap, in-memory, and harmless either way. Client
 * names are all prefixed `rg2-` per the multi-agent naming convention (rg1 =
 * helpers, rg3 = same function's later half, rg4 = MCP path, rg5a/rg5b =
 * GraphQL path) so no collision is possible even if another sibling file's
 * tests happen to run in the same process.
 */
import { describe, test, expect, beforeEach, afterEach, spyOn, type Mock } from "bun:test";
import { performRestRegistration, type RegisterOutcome } from "../../mcp/registration.js";
import { __resetDbForTesting } from "../../db/connection.js";
import * as ipValidatorMod from "../../net/ip-validator.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let seq = 0;
function uniqueName(label: string): string {
  seq += 1;
  return `rg2-${label}-${seq}`;
}

let validateSpy: Mock<typeof ipValidatorMod.validateBackendUrl>;

beforeEach(() => {
  __resetDbForTesting();
  validateSpy = spyOn(ipValidatorMod, "validateBackendUrl");
});

afterEach(() => {
  validateSpy.mockRestore();
});

/** Exact shape of the "all SSRF checks passed" marker outcome — see file header. */
const TOOLS_MARKER_RESULT: RegisterOutcome = {
  ok: false,
  status: 400,
  body: { error: { code: "VALIDATION_ERROR", message: "'tools' must be an array" } },
};

/** Makes every call to the spied validateBackendUrl resolve valid:true. */
function mockAllValid(resolvedIp = "198.51.100.9"): void {
  validateSpy.mockResolvedValue({ valid: true, resolvedIp });
}

// ---------------------------------------------------------------------------
// L169:7 LogicalOperator (|| -> &&) + BlockStatement -> {}
//   if (!name || !health_url) {
//     return { ok:false, status:400, body:{ error:{ code:"VALIDATION_ERROR",
//       message:"Missing required fields: name, health_url" } } };
//   }
// ---------------------------------------------------------------------------

describe("required fields — L169 (!name || !health_url)", () => {
  const EXPECTED: RegisterOutcome = {
    ok: false,
    status: 400,
    body: { error: { code: "VALIDATION_ERROR", message: "Missing required fields: name, health_url" } },
  };

  test("name missing, health_url present -> exact validation error", async () => {
    const result = await performRestRegistration(
      { health_url: "http://good.example/health", tools: [] },
      undefined,
      "rid-a1",
    );
    expect(result).toEqual(EXPECTED);
    expect(validateSpy).not.toHaveBeenCalled();
  });

  test("health_url missing, name present -> exact validation error (proves || not &&)", async () => {
    // Under a && mutant, this alone (name present, only health_url falsy)
    // would NOT satisfy the guard, since name is truthy — the mutant would
    // require BOTH to be falsy. This test alone already distinguishes || vs
    // &&, since the real code only needs one side falsy.
    const result = await performRestRegistration({ name: uniqueName("b"), tools: [] }, undefined, "rid-a2");
    expect(result).toEqual(EXPECTED);
    expect(validateSpy).not.toHaveBeenCalled();
  });

  test("both present -> proceeds past this guard (chains into the L189 providedCount===0 error instead)", async () => {
    // No discovery-source field supplied at all, so if (and only if) this
    // guard's return correctly fires ONLY for the missing-field case (i.e.
    // is not a BlockStatement -> {} no-op, and not falsely triggered here),
    // execution proceeds to the discovery-source count check and gets ITS
    // distinct message — proof this guard did not fire when both required
    // fields are present.
    const result = await performRestRegistration(
      { name: uniqueName("c"), health_url: "http://good.example/health" },
      undefined,
      "rid-a3",
    );
    expect(result).toEqual({
      ok: false,
      status: 400,
      body: {
        error: {
          code: "VALIDATION_ERROR",
          message: "Must provide exactly one of 'tools', 'openapi_url', 'curl_input', or 'postman_collection'",
        },
      },
    });
    expect(validateSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// L184-187 — discovery-source boolean flags:
//   hasTools    = tools !== undefined && tools !== null
//   hasOpenapi  = typeof openapi_url === "string" && openapi_url.length > 0
//   hasCurl     = typeof curl_input === "string" && curl_input.trim().length > 0
//   hasPostman  = postman_collection !== undefined && postman_collection !== null && postman_collection !== ""
// Feed L188's providedCount, tested against the L189/L201 messages below.
// ---------------------------------------------------------------------------

describe("discovery-source flags — L184-187 boundary values, via L189/L201 messages", () => {
  const ZERO_MSG = "Must provide exactly one of 'tools', 'openapi_url', 'curl_input', or 'postman_collection'";
  const MANY_MSG = "Provide exactly one of 'tools', 'openapi_url', 'curl_input', or 'postman_collection', not several";

  test("all four falsy-but-tricky boundary values -> providedCount 0 (tools:null, openapi_url:'', curl_input whitespace-only, postman_collection:'')", async () => {
    // tools: null (not undefined) pins the `tools !== null` operand.
    // openapi_url: "" pins `openapi_url.length > 0` (empty string, not absent).
    // curl_input: "   " pins `.trim().length > 0` (whitespace-only, not absent).
    // postman_collection: "" pins `postman_collection !== ""` (present but empty string).
    const result = await performRestRegistration(
      {
        name: uniqueName("d1"),
        health_url: "http://good.example/health",
        tools: null,
        openapi_url: "",
        curl_input: "   ",
        postman_collection: "",
      },
      undefined,
      null,
    );
    expect(result).toEqual({
      ok: false,
      status: 400,
      body: { error: { code: "VALIDATION_ERROR", message: ZERO_MSG } },
    });
    expect(validateSpy).not.toHaveBeenCalled();
  });

  test("postman_collection: null (distinct from '') alone still counts as not-provided -> providedCount 0", async () => {
    // Isolates the `postman_collection !== null` operand from the
    // `!== ""` operand tested above — a mutant that duplicated/dropped the
    // null check specifically would treat a bare `null` as "provided".
    const result = await performRestRegistration(
      { name: uniqueName("d2"), health_url: "http://good.example/health", postman_collection: null },
      undefined,
      null,
    );
    expect(result).toEqual({
      ok: false,
      status: 400,
      body: { error: { code: "VALIDATION_ERROR", message: ZERO_MSG } },
    });
    expect(validateSpy).not.toHaveBeenCalled();
  });

  test("tools:[] (empty array, truthy-provided) + openapi_url non-empty -> providedCount 2 (proves hasTools true for [] and hasOpenapi true for a real URL)", async () => {
    const result = await performRestRegistration(
      {
        name: uniqueName("d3"),
        health_url: "http://good.example/health",
        tools: [],
        openapi_url: "http://oapi.example/spec.json",
      },
      undefined,
      null,
    );
    expect(result).toEqual({
      ok: false,
      status: 400,
      body: { error: { code: "VALIDATION_ERROR", message: MANY_MSG } },
    });
    expect(validateSpy).not.toHaveBeenCalled();
  });

  test("curl_input real content + postman_collection:{} (empty object, not empty string) -> providedCount 2 (proves hasCurl true after trim and hasPostman true for a non-string value)", async () => {
    const result = await performRestRegistration(
      {
        name: uniqueName("d4"),
        health_url: "http://good.example/health",
        curl_input: "curl -X GET http://example.com/api",
        postman_collection: {},
      },
      undefined,
      null,
    );
    expect(result).toEqual({
      ok: false,
      status: 400,
      body: { error: { code: "VALIDATION_ERROR", message: MANY_MSG } },
    });
    expect(validateSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// L216-229 — peer-IP-required-for-relative-health_url:
//   if (!health_url.startsWith("http") && !peerIp) return {...};
//   const ip = peerIp || "127.0.0.1";
// ---------------------------------------------------------------------------

describe("peer-IP-required guard — L216-229", () => {
  test("relative health_url, no peerIp -> exact error (includes request_id, unlike the other guards in this file)", async () => {
    const result = await performRestRegistration(
      { name: uniqueName("e1"), health_url: "/health", tools: [] },
      undefined,
      "rid-e1",
    );
    expect(result).toEqual({
      ok: false,
      status: 400,
      body: {
        error: {
          code: "VALIDATION_ERROR",
          message: "Cannot determine peer IP for relative health_url",
          request_id: "rid-e1",
        },
      },
    });
    expect(validateSpy).not.toHaveBeenCalled();
  });

  // "relative health_url WITH a peerIp must proceed, using that peerIp as
  // `ip`" is proven by the L232-244 describe block below (E1/E2), which
  // asserts the EXACT resolvedHealthUrl string built from a relative
  // health_url + a supplied peerIp — a stronger assertion than merely
  // observing "no error" here, since it pins the actual value of `ip`.

  test("absolute health_url, NO peerIp -> proceeds regardless (kills the && -> || mutant, which would wrongly require peerIp even for an absolute URL)", async () => {
    validateSpy.mockResolvedValueOnce({ valid: false, reason: "abs-no-peer-reason" });
    const result = await performRestRegistration(
      { name: uniqueName("e2"), health_url: "http://good.example/health", tools: [] },
      undefined,
      "rid-e2",
    );
    // Reaching the SSRF-invalid message at all (rather than "Cannot
    // determine peer IP...") proves the guard did not fire despite peerIp
    // being undefined, because health_url is absolute.
    expect(result).toEqual({
      ok: false,
      status: 400,
      body: { error: { code: "VALIDATION_ERROR", message: "Invalid health_url: abs-no-peer-reason" } },
    });
    // Also proves the resolvedHealthUrl ternary took the "absolute" branch
    // (health_url unchanged) rather than reconstructing it from `ip` (which
    // would produce a garbled "http://127.0.0.1/http://good.example/health"
    // style string under a flipped ternary condition).
    expect(validateSpy.mock.calls[0]?.[0]).toBe("http://good.example/health");
  });
});

// ---------------------------------------------------------------------------
// L232-244 — health_url resolution template + SSRF validation:
//   const resolvedHealthUrl = health_url.startsWith("http")
//     ? health_url
//     : `http://${ip}${health_url.startsWith("/") ? "" : "/"}${health_url}`;
//   const healthValidation = await validateBackendUrl(resolvedHealthUrl, ...);
//   if (!healthValidation.valid) return {... `Invalid health_url: ${reason}` ...};
// ---------------------------------------------------------------------------

describe("health_url resolution + SSRF — L232-244", () => {
  test("relative health_url WITHOUT a leading slash gets exactly one slash inserted", async () => {
    validateSpy.mockResolvedValueOnce({ valid: false, reason: "f1-marker" });
    const result = await performRestRegistration(
      { name: uniqueName("f1"), health_url: "health", tools: [] },
      "203.0.113.7",
      null,
    );
    expect(validateSpy.mock.calls[0]?.[0]).toBe("http://203.0.113.7/health");
    expect(result).toEqual({
      ok: false,
      status: 400,
      body: { error: { code: "VALIDATION_ERROR", message: "Invalid health_url: f1-marker" } },
    });
  });

  test("relative health_url WITH a leading slash does not get a double slash (and proves relative+peerIp proceeds, using that peerIp as `ip`)", async () => {
    validateSpy.mockResolvedValueOnce({ valid: false, reason: "f2-marker" });
    const result = await performRestRegistration(
      { name: uniqueName("f2"), health_url: "/health", tools: [] },
      "203.0.113.7",
      null,
    );
    expect(validateSpy.mock.calls[0]?.[0]).toBe("http://203.0.113.7/health");
    expect(result).toEqual({
      ok: false,
      status: 400,
      body: { error: { code: "VALIDATION_ERROR", message: "Invalid health_url: f2-marker" } },
    });
  });

  test("!healthValidation.valid -> exact 'Invalid health_url: <reason>' message, no request_id key, under the RELATIVE-url ternary branch", async () => {
    validateSpy.mockResolvedValueOnce({ valid: false, reason: "relative-reason" });
    const result = await performRestRegistration(
      { name: uniqueName("f3"), health_url: "/health", tools: [] },
      "203.0.113.9",
      "rid-f3",
    );
    // request_id is NOT part of this error's body (unlike the peer-IP guard's
    // error) — toEqual on the full object catches an over-eager mutant that
    // added it, as well as any status/code/message drift.
    expect(result).toEqual({
      ok: false,
      status: 400,
      body: { error: { code: "VALIDATION_ERROR", message: "Invalid health_url: relative-reason" } },
    });
  });
});

// ---------------------------------------------------------------------------
// L249-277 — base_url resolution + SSRF validation:
//   if (base_url) {
//     if (!base_url.startsWith("http://") && !base_url.startsWith("https://")) return {..."base_url must start with http:// or https://"...};
//     resolvedBaseUrl = base_url;
//   } else {
//     try { resolvedBaseUrl = `${protocol}//${host}` from resolvedHealthUrl; }
//     catch { resolvedBaseUrl = `http://${ip}`; }
//   }
//   const baseUrlValidation = await validateBackendUrl(resolvedBaseUrl, ...);
//   if (!baseUrlValidation.valid) return {... `Invalid base_url: ${reason}` ...};
// ---------------------------------------------------------------------------

describe("base_url resolution + SSRF — L249-277", () => {
  test("explicit base_url with a bad scheme -> exact error, and validateBackendUrl is called only ONCE (for health_url; base_url's own SSRF check never runs)", async () => {
    validateSpy.mockResolvedValueOnce({ valid: true, resolvedIp: "9.9.9.9" });
    const result = await performRestRegistration(
      { name: uniqueName("g1"), health_url: "http://good.example/health", base_url: "ftp://x", tools: [] },
      undefined,
      null,
    );
    expect(result).toEqual({
      ok: false,
      status: 400,
      body: { error: { code: "VALIDATION_ERROR", message: "base_url must start with http:// or https://" } },
    });
    expect(validateSpy).toHaveBeenCalledTimes(1);
  });

  test.each(["http://good-target.example", "https://good-target.example"])(
    "explicit base_url %s (valid scheme) proceeds unmodified past the scheme check (kills && -> || on the scheme guard, from both operand sides)",
    async (baseUrl) => {
      mockAllValid();
      const result = await performRestRegistration(
        {
          name: uniqueName("g2"),
          health_url: "http://good.example/health",
          base_url: baseUrl,
          tools: "not-an-array-marker",
        },
        undefined,
        null,
      );
      // resolvedBaseUrl = base_url verbatim (the `resolvedBaseUrl = base_url;`
      // assignment, not a derived/rebuilt string).
      expect(validateSpy.mock.calls[1]?.[0]).toBe(baseUrl);
      // Reaching the L329 tools-array marker proves BOTH SSRF calls (health_url
      // then base_url) returned valid, i.e. this guard did not wrongly reject
      // a well-formed http(s) base_url.
      expect(result).toEqual(TOOLS_MARKER_RESULT);
    },
  );

  test("base_url omitted -> derived as `${protocol}//${host}` from the parsed resolvedHealthUrl", async () => {
    mockAllValid();
    const result = await performRestRegistration(
      {
        name: uniqueName("g3"),
        health_url: "http://myhost.example:1234/health/path?x=1",
        tools: "not-an-array-marker",
      },
      undefined,
      null,
    );
    expect(validateSpy.mock.calls[0]?.[0]).toBe("http://myhost.example:1234/health/path?x=1");
    expect(validateSpy.mock.calls[1]?.[0]).toBe("http://myhost.example:1234");
    expect(result).toEqual(TOOLS_MARKER_RESULT);
  });

  test("base_url omitted + resolvedHealthUrl unparseable by `new URL()` -> catch fallback `http://${ip}`", async () => {
    // Verified empirically (bun -e) that `new URL("http://[bad")` throws —
    // an unterminated/invalid IPv6-literal bracket in the host position.
    // health_url starts with "http" so resolvedHealthUrl is passed through
    // unchanged (this test does not depend on the L232 template logic at
    // all); the spy fully replaces validateBackendUrl, so the malformed URL
    // never needs to survive a REAL parse there either.
    mockAllValid();
    const result = await performRestRegistration(
      { name: uniqueName("g4"), health_url: "http://[bad", tools: "not-an-array-marker" },
      "198.51.100.5",
      null,
    );
    expect(validateSpy.mock.calls[1]?.[0]).toBe("http://198.51.100.5");
    expect(result).toEqual(TOOLS_MARKER_RESULT);
  });

  test("!baseUrlValidation.valid -> exact 'Invalid base_url: <reason>' message, no request_id key", async () => {
    validateSpy.mockResolvedValueOnce({ valid: true, resolvedIp: "9.9.9.9" });
    validateSpy.mockResolvedValueOnce({ valid: false, reason: "base-block-reason" });
    const result = await performRestRegistration(
      {
        name: uniqueName("g5"),
        health_url: "http://good.example/health",
        base_url: "http://bad-target.example",
        tools: [],
      },
      undefined,
      "rid-g5",
    );
    expect(result).toEqual({
      ok: false,
      status: 400,
      body: { error: { code: "VALIDATION_ERROR", message: "Invalid base_url: base-block-reason" } },
    });
    expect(validateSpy).toHaveBeenCalledTimes(2);
  });
});
