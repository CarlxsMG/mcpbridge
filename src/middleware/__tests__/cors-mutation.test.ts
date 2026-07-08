/**
 * Stryker mutation-testing backstop for src/middleware/cors.ts.
 *
 * Documented equivalents (not chased further, both re-verified empirically
 * via a standalone `bun -e` simulation on each new verify round they
 * appeared in): the `origins[0] === "*"` wildcard fast-path in
 * `matchAllowedOrigin` (both a ConditionalExpression-forced-false variant
 * and a StringLiteral-emptied variant across different verify rounds) is
 * structurally redundant with TWO independent things that are unaffected by
 * mutating it: `matchesOriginEntry`'s OWN `entry === "*"` unconditional-match
 * check (so `.find()` still returns "*" as a non-null `allowedOrigin`), and
 * `corsMiddleware`'s separately-computed `isWildcard` flag (which reads
 * `config.corsOrigins[0] === "*"` directly and is untouched by mutating the
 * fast-path inside `matchAllowedOrigin`) — so the final header value is
 * identical either way. Same reasoning kills a THIRD sibling mutant on
 * `if (isWildcard)` one level up (forced false): whenever `isWildcard` is
 * true, the fast path is GUARANTEED to have already fired (same condition),
 * so `allowedOrigin` already equals `requestOrigin`, making the two branches
 * of that `if` produce the same header value regardless of which one runs.
 * A 4th sibling survivor, `origins.length === 0` forced false, is
 * ALSO equivalent by the same downstream reasoning: with `origins = []`,
 * skipping the early `return null` just falls through to `[].find(...)`,
 * which returns `undefined` regardless of its predicate — `?? null`
 * coerces that back to the exact same `null` the early return would have
 * produced. Verified empirically (`bun -e`) on every variant above before
 * accepting.
 * Also documented: 45:87-98:2 BlockStatement [Timeout] (corsMiddleware's
 * entire body emptied) — a route-handler-body-emptied timeout, the same
 * "Stryker itself detects it via timeout" pattern used throughout this
 * whole mutation-testing program (transports.ts, mcp-server.ts, auth.ts).
 */
import { describe, test, expect } from "bun:test";
import type { Request, Response, NextFunction } from "express";
import { corsMiddleware } from "../../middleware/cors.js";
import { config } from "../../config.js";

function makeRes() {
  const res = {
    _statusCode: undefined as number | undefined,
    _headers: {} as Record<string, string>,
    setHeader(name: string, value: string) {
      this._headers[name] = value;
      return res;
    },
    sendStatus(code: number) {
      this._statusCode = code;
      return res;
    },
  };
  return res;
}

function makeNext(): { called: boolean; fn: NextFunction } {
  const state = { called: false, fn: null as unknown as NextFunction };
  state.fn = () => {
    state.called = true;
  };
  return state;
}

// 26:99-26:104 BooleanLiteral [Survived] (`{ supportsPortWildcard: false }`
// flipped to `true`). cors.ts's own docstring is explicit that its
// allowlist does NOT support the ":*" port-wildcard suffix — that's
// origin-validator.ts's rule, not this file's. A ":*"-suffixed entry must
// NOT match via the port-wildcard branch here.
describe("corsMiddleware — port-wildcard suffix is NOT supported", () => {
  test("a ':*'-suffixed corsOrigins entry does not match a different-port request", () => {
    const orig = config.corsOrigins;
    (config as Record<string, unknown>).corsOrigins = ["https://example.com:*"];
    try {
      const req = {
        headers: { origin: "https://example.com:9999" },
        method: "GET",
      } as unknown as Request;
      const res = makeRes();
      const next = makeNext();
      corsMiddleware(req, res as unknown as Response, next.fn);
      expect(res._headers["Access-Control-Allow-Origin"]).toBeUndefined();
      expect(next.called).toBe(true);
    } finally {
      (config as Record<string, unknown>).corsOrigins = orig;
    }
  });
});
