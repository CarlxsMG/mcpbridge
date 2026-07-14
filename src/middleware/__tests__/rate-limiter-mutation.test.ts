/**
 * Stryker mutation-testing backstop for src/middleware/rate-limiter.ts's
 * Express-facing middleware factories (rateLimitInstallLink/Mcp/Global) and
 * the background idle-bucket eviction sweep (evictEmpty +
 * startRateLimiterCleanup) — the existing rate-limiter.test.ts and
 * rate-limiter-tool-tier.test.ts thoroughly cover the LRU map primitives and
 * the pure checkRateLimit/checkLimit functions, but never touch the
 * Express-wrapped middleware factories directly, nor the cleanup sweep at
 * all (it had zero coverage — the whole evictEmpty function body was an
 * unreached survivor at baseline).
 *
 * Documented equivalent (not chased further): 97:24-97:26 ArrayDeclaration
 * (`bucket = { tokens: [] }` -> `{ tokens: ["Stryker was here"] }` on a
 * freshly-created bucket). Verified empirically (`bun -e`) that the very
 * next line's sliding-window prune — `bucket.tokens.filter((t) => now - t <
 * WINDOW_MS)` — unconditionally strips the injected string: `now - "Stryker
 * was here"` is `NaN`, and `NaN < WINDOW_MS` is always `false`, so the junk
 * entry never survives to be observed through any call path.
 */
import { describe, test, expect, spyOn } from "bun:test";
import type { Request, Response, NextFunction } from "express";
import {
  rateLimitRegister,
  rateLimitLogin,
  rateLimitInstallLink,
  rateLimitMcp,
  rateLimitGlobal,
  checkToolRateLimit,
  checkRateLimit,
  startRateLimiterCleanup,
  _internalsForTesting,
} from "../../middleware/rate-limiter.js";
import { rateLimitHits, rateLimitEvictions } from "../../observability/metrics.js";
import * as leaderLoopMod from "../../lib/leader-loop.js";
import * as loggerMod from "../../logger.js";

const { globalBuckets, mcpBuckets, registerBuckets, toolBuckets, loginBuckets, installLinkBuckets } =
  _internalsForTesting;

function makeFakeRes(): { res: Response; statusCode?: number } {
  const state: { statusCode?: number } = {};
  const res = {
    setHeader() {
      return res;
    },
    status(code: number) {
      state.statusCode = code;
      return res;
    },
    json() {
      return res;
    },
  } as unknown as Response;
  return {
    res,
    get statusCode() {
      return state.statusCode;
    },
  };
}

function makeNext(): { called: boolean; fn: NextFunction } {
  const state = { called: false, fn: null as unknown as NextFunction };
  state.fn = () => {
    state.called = true;
  };
  return state;
}

function makeReq(overrides: Record<string, unknown> = {}): Request {
  return { headers: {}, query: {}, socket: {}, ...overrides } as unknown as Request;
}

// 68:9-68:29 ConditionalExpression [Survived] (`if (Math.random() < 0.01)`
// forced always-true — the log would fire on EVERY eviction, not a 1%
// sample) / 69:48-69:87 ObjectLiteral [Survived] (`{ evicted_key_hash: ... }`
// emptied to `{}`).
describe("lruSet — sampled eviction logging", () => {
  test("does NOT log when the 1% sample roll misses", () => {
    const { lruSet } = _internalsForTesting;
    const map = new Map<string, { tokens: number[] }>();
    map.set("existing", { tokens: [] });
    const logSpy = spyOn(loggerMod, "log").mockImplementation(() => {});
    const randomSpy = spyOn(Math, "random").mockReturnValue(0.5); // >= 0.01 -> not sampled
    try {
      lruSet(map, "new-key", { tokens: [] }, 1, "test-tier");
      expect(logSpy).not.toHaveBeenCalled();
    } finally {
      logSpy.mockRestore();
      randomSpy.mockRestore();
    }
  });

  test("logs the exact level/message and a real evicted_key_hash when the 1% sample hits", () => {
    const { lruSet } = _internalsForTesting;
    const map = new Map<string, { tokens: number[] }>();
    map.set("existing2", { tokens: [] });
    const logSpy = spyOn(loggerMod, "log").mockImplementation(() => {});
    const randomSpy = spyOn(Math, "random").mockReturnValue(0); // < 0.01 -> sampled
    try {
      lruSet(map, "new-key-2", { tokens: [] }, 1, "test-tier");
      expect(logSpy).toHaveBeenCalledTimes(1);
      const [level, message, meta] = logSpy.mock.calls[0] as [string, string, { evicted_key_hash?: string }];
      expect(level).toBe("warn");
      expect(message).toBe("Rate-limiter LRU eviction");
      expect(meta?.evicted_key_hash).toMatch(/^[0-9a-f]{12}$/);
    } finally {
      logSpy.mockRestore();
      randomSpy.mockRestore();
    }
  });
});

// 106:35-106:67 ArithmeticOperator [Survived] (`oldestInWindow + WINDOW_MS -
// now` flipped to `+ now`) / 108:9-108:15 StringLiteral [Survived] ("warn"
// emptied). Existing sibling tests only assert `retryAfterSeconds >
// 0` — a `+`-flipped mutant still produces a positive (if huge) number, so
// only an EXACT expected value distinguishes them.
describe("checkRateLimit — retryAfterSeconds exact computation", () => {
  test('computes the exact retryAfterSeconds from oldestInWindow/WINDOW_MS/now, and logs at the exact "warn" level', () => {
    const map = new Map<string, { tokens: number[] }>();
    const realNow = Date.now;
    const logSpy = spyOn(loggerMod, "log").mockImplementation(() => {});
    try {
      const t0 = realNow();
      Date.now = () => t0;
      checkRateLimit(map, 100, "retry-key", 1, "test"); // 1st call — fills the limit of 1

      Date.now = () => t0 + 10_000; // 10s later
      logSpy.mockClear();
      const blocked = checkRateLimit(map, 100, "retry-key", 1, "test");

      expect(blocked.allowed).toBe(false);
      // Real: ceil((t0 + 60_000 - (t0 + 10_000)) / 1000) = 50.
      expect(blocked.retryAfterSeconds).toBe(50);
      expect(logSpy).toHaveBeenCalledTimes(1);
      expect(logSpy.mock.calls[0]?.[0]).toBe("warn");
      // 108:17-108:39 StringLiteral [Survived] ("Rate limit triggered"
      // emptied).
      expect(logSpy.mock.calls[0]?.[1]).toBe("Rate limit triggered");
      // 108:41-114:6 ObjectLiteral [Survived] (the meta object emptied to
      // `{}`) — assert its exact shape, not just the level.
      const meta = logSpy.mock.calls[0]?.[2] as Record<string, unknown>;
      expect(meta).toEqual({
        tier: "test",
        key_hash: expect.any(String),
        current: 1,
        limit: 1,
        retry_after: 50,
      });
    } finally {
      Date.now = realNow;
      logSpy.mockRestore();
    }
  });

  // 102:19-102:67 MethodExpression [Survived] (`bucket.tokens.filter(...)`
  // call itself removed, leaving `bucket.tokens = bucket.tokens` — a token
  // would never age out of the sliding window at all).
  test("prunes tokens older than WINDOW_MS before counting against the limit", () => {
    const map = new Map<string, { tokens: number[] }>();
    const realNow = Date.now;
    try {
      const t0 = realNow();
      Date.now = () => t0;
      checkRateLimit(map, 100, "prune-key", 1, "test"); // fills the limit of 1 at t0

      Date.now = () => t0 + 60_001; // just past the default WINDOW_MS (60_000)
      const result = checkRateLimit(map, 100, "prune-key", 1, "test");
      expect(result.allowed).toBe(true); // the old token must have aged out
    } finally {
      Date.now = realNow;
    }
  });
});

// 207:51-207:76 OptionalChaining [Survived] (`req.socket?.remoteAddress`
// with the `?.` removed — throws when req.socket is undefined).
describe("rateLimitRegister", () => {
  test("does not throw when both req.ip and req.socket are absent", () => {
    registerBuckets.clear();
    const mw = rateLimitRegister(5);
    const req = { headers: {}, query: {} } as unknown as Request;
    const res = makeFakeRes();
    const next = makeNext();
    expect(() => mw(req, res.res, next.fn)).not.toThrow();
    expect(next.called).toBe(true);
  });

  // 208:92-208:102 StringLiteral [Survived] ("register" tier emptied).
  test('a rate-limited request records the exact "register" tier', () => {
    registerBuckets.clear();
    const mw = rateLimitRegister(1);
    const req = makeReq({ ip: "4.4.4.4" });
    mw(req, makeFakeRes().res, makeNext().fn);
    mw(req, makeFakeRes().res, makeNext().fn);
    expect(rateLimitHits.render()).toContain('{tier="register"}');
  });
});

// 217:17-217:76 StringLiteral [Survived] (the whole `` `login:${...}` ``
// template literal collapsed to an empty string — every caller would
// collapse onto ONE shared bucket regardless of IP).
describe("rateLimitLogin", () => {
  test("keys buckets by the real per-IP key, not a collapsed empty string", () => {
    loginBuckets.clear();
    const mw = rateLimitLogin(10);
    mw(makeReq({ ip: "1.1.1.1" }), makeFakeRes().res, makeNext().fn);
    mw(makeReq({ ip: "2.2.2.2" }), makeFakeRes().res, makeNext().fn);
    expect(loginBuckets.has("login:1.1.1.1")).toBe(true);
    expect(loginBuckets.has("login:2.2.2.2")).toBe(true);
  });

  // 218:86-218:93 StringLiteral [Survived] ("login" tier emptied).
  test('an allowed request calls next(); a rate-limited one does not, recording the exact "login" tier', () => {
    loginBuckets.clear();
    const mw = rateLimitLogin(1);
    const req = makeReq({ ip: "3.3.3.3" });

    const first = makeFakeRes();
    const next1 = makeNext();
    mw(req, first.res, next1.fn);
    expect(next1.called).toBe(true);

    const second = makeFakeRes();
    const next2 = makeNext();
    mw(req, second.res, next2.fn);
    expect(next2.called).toBe(false);
    expect(second.statusCode).toBe(429);
    expect(rateLimitHits.render()).toContain('{tier="login"}');
  });
});

// 231:9-231:118 ConditionalExpression [Survived] (the `if (checkLimit(...))`
// forced always-true — a rejected request would still call next()) /
// 231:120-233:6 BlockStatement [Survived] (the `{ next(); }` body emptied —
// an allowed request would never call next()).
describe("rateLimitInstallLink", () => {
  test("an allowed request calls next(); a rate-limited one does not", () => {
    installLinkBuckets.clear();
    const mw = rateLimitInstallLink(1);
    const req = makeReq({ ip: "9.9.9.9" });

    const first = makeFakeRes();
    const next1 = makeNext();
    mw(req, first.res, next1.fn);
    expect(next1.called).toBe(true);
    expect(first.statusCode).toBeUndefined();

    const second = makeFakeRes();
    const next2 = makeNext();
    mw(req, second.res, next2.fn);
    expect(next2.called).toBe(false);
    expect(second.statusCode).toBe(429);
  });

  // 230:55-230:80 OptionalChaining [Survived] (`req.socket?.remoteAddress`
  // with the `?.` removed — throws when req.socket is undefined).
  test("does not throw when both req.ip and req.socket are absent", () => {
    installLinkBuckets.clear();
    const mw = rateLimitInstallLink(5);
    const req = { headers: {}, query: {} } as unknown as Request;
    const res = makeFakeRes();
    const next = makeNext();
    expect(() => mw(req, res.res, next.fn)).not.toThrow();
    expect(next.called).toBe(true);
  });

  // 230:45-230:80 LogicalOperator [Survived] (`req.ip ?? req.socket?.
  // remoteAddress` flipped to `&&`). `??`/`&&` only diverge when the LEFT
  // operand is truthy: `??` returns it directly (real code), `&&` evaluates
  // and returns the RIGHT operand instead. A truthy req.ip together with a
  // DIFFERENT socket.remoteAddress distinguishes them.
  test("uses req.ip directly when truthy, not overridden by a different req.socket.remoteAddress", () => {
    installLinkBuckets.clear();
    const mw = rateLimitInstallLink(10);
    const req = makeReq({ ip: "5.5.5.5", socket: { remoteAddress: "6.6.6.6" } });
    mw(req, makeFakeRes().res, makeNext().fn);
    expect(installLinkBuckets.has("install_link:5.5.5.5")).toBe(true);
    expect(installLinkBuckets.has("install_link:6.6.6.6")).toBe(false);
  });

  // 231:98-231:112 StringLiteral [Survived] ("install_link" tier emptied).
  test('a rate-limited request records the exact "install_link" tier', () => {
    installLinkBuckets.clear();
    const mw = rateLimitInstallLink(1);
    const req = makeReq({ ip: "1.2.3.4" });
    mw(req, makeFakeRes().res, makeNext().fn);
    mw(req, makeFakeRes().res, makeNext().fn);
    expect(rateLimitHits.render()).toContain('{tier="install_link"}');
  });
});

// 253:9-253:102 ConditionalExpression [Survived] (same "forced always-true"
// shape as rateLimitInstallLink, for the global tier) / 253:88-253:96
// StringLiteral [Survived] ("global" tier emptied).
describe("rateLimitGlobal", () => {
  test('an allowed request calls next(); a rate-limited one does not, recording the exact "global" tier', () => {
    globalBuckets.clear();
    const mw = rateLimitGlobal(1);
    const req = makeReq();

    const first = makeFakeRes();
    const next1 = makeNext();
    mw(req, first.res, next1.fn);
    expect(next1.called).toBe(true);

    const second = makeFakeRes();
    const next2 = makeNext();
    mw(req, second.res, next2.fn);
    expect(next2.called).toBe(false);
    expect(second.statusCode).toBe(429);
    expect(rateLimitHits.render()).toContain('{tier="global"}');
  });

  // 252:17-252:25 StringLiteral [Survived] (`const key = "global"` emptied
  // to "" — every caller would share the SAME "" bucket, indistinguishable
  // from a real "global" key with only a single-request test).
  test('uses the exact "global" bucket key, not an empty string', () => {
    globalBuckets.clear();
    const mw = rateLimitGlobal(10);
    mw(makeReq(), makeFakeRes().res, makeNext().fn);
    expect(globalBuckets.has("global")).toBe(true);
    expect(globalBuckets.has("")).toBe(false);
  });
});

describe("rateLimitMcp", () => {
  // The (client-controlled) session id SUBDIVIDES a source IP's allowance: two
  // distinct session ids from the same IP must produce two distinct per-session
  // bucket keys (kills any mutant that collapses the sessionId onto a constant),
  // while both share the per-IP ceiling bucket.
  test("subdivides an IP's allowance by the real mcp-session-id header, not a mutated constant", () => {
    mcpBuckets.clear();
    const mw = rateLimitMcp(10);
    mw(makeReq({ ip: "5.5.5.5", headers: { "mcp-session-id": "session-A" } }), makeFakeRes().res, makeNext().fn);
    mw(makeReq({ ip: "5.5.5.5", headers: { "mcp-session-id": "session-B" } }), makeFakeRes().res, makeNext().fn);
    expect(mcpBuckets.has("mcp:5.5.5.5:session-A")).toBe(true);
    expect(mcpBuckets.has("mcp:5.5.5.5:session-B")).toBe(true);
    expect(mcpBuckets.has("mcp_ip:5.5.5.5")).toBe(true); // shared per-IP ceiling
  });

  // 244:82-244:87 StringLiteral [Survived] ("mcp" tier emptied) / 244:95-
  // 246:6 BlockStatement [Survived] (the `{ next(); }` body emptied).
  test('an allowed request calls next(); a rate-limited one does not, recording the exact "mcp" tier', () => {
    mcpBuckets.clear();
    const mw = rateLimitMcp(1);
    const req = makeReq({ headers: { "mcp-session-id": "session-tier-test" } });

    const first = makeFakeRes();
    const next1 = makeNext();
    mw(req, first.res, next1.fn);
    expect(next1.called).toBe(true);

    const second = makeFakeRes();
    const next2 = makeNext();
    mw(req, second.res, next2.fn);
    expect(next2.called).toBe(false);
    expect(second.statusCode).toBe(429);
    expect(rateLimitHits.render()).toContain('{tier="mcp"}');
  });

  // The per-IP ceiling keys off `req.ip ?? req.socket?.remoteAddress` — req.ip
  // must win when present (not be overridden by a different socket.remoteAddress).
  // With no session id present, only the per-IP ceiling bucket is created.
  test("keys the per-IP ceiling by req.ip directly (not by socket.remoteAddress) when no session-id is present", () => {
    mcpBuckets.clear();
    const mw = rateLimitMcp(10);
    const req = makeReq({ ip: "7.7.7.7", socket: { remoteAddress: "8.8.8.8" } });
    mw(req, makeFakeRes().res, makeNext().fn);
    expect(mcpBuckets.has("mcp_ip:7.7.7.7")).toBe(true);
    expect(mcpBuckets.has("mcp_ip:8.8.8.8")).toBe(false);
  });
});

// 266:93-266:99 StringLiteral [Survived] ("tool" tier emptied).
describe("checkToolRateLimit", () => {
  test('records a rejection under the exact "tool" tier', () => {
    toolBuckets.clear();
    const key = "svc__tier-string-test";
    checkToolRateLimit(key, 1);
    checkToolRateLimit(key, 1); // exceeds the limit of 1
    expect(rateLimitHits.render()).toContain('{tier="tool"}');
  });
});

// 179:67-188:2 BlockStatement [Survived] (evictEmpty's entire body emptied —
// it had ZERO coverage at baseline) / 182:49-182:68 ConditionalExpression
// [Survived] + EqualityOperator [Survived] (the prune filter's `<` boundary,
// forced `false`/`<=`) / 183:9-183:35 EqualityOperator [Survived] (`=== 0`
// flipped to `!== 0`) / 183:37-186:6 BlockStatement [Survived] (the delete +
// metric body emptied) / 195:35-202:4 BlockStatement [Survived] (the whole
// sweep callback emptied) / 196:31-196:39 + 199:29-199:35 StringLiteral
// [Survived] ("global"/"tool" tier args emptied). Captures the real sweep
// callback (bypassing setInterval, same technique as
// circuit-breaker-mutation.test.ts) and drives it directly against all six
// bucket maps at once.
describe("startRateLimiterCleanup — idle-bucket eviction sweep", () => {
  test("prunes a token exactly WINDOW_MS old to empty (and evicts the bucket) while preserving a fresh token, across all six tier maps", () => {
    const maps: Array<[Map<string, { tokens: number[] }>, string]> = [
      [globalBuckets, "global"],
      [mcpBuckets, "mcp"],
      [registerBuckets, "register"],
      [toolBuckets, "tool"],
      [loginBuckets, "login"],
      [installLinkBuckets, "install_link"],
    ];

    let capturedFn: (() => void) | undefined;
    const startSpy = spyOn(leaderLoopMod, "startPeriodicSweep").mockImplementation((fn) => {
      capturedFn = fn as () => void;
      return () => {};
    });
    const realNow = Date.now;
    try {
      startRateLimiterCleanup();
      expect(capturedFn).toBeDefined();

      const now = realNow();
      for (const [map, tier] of maps) {
        map.set(`stale-${tier}`, { tokens: [now - 60_000] }); // exactly WINDOW_MS old
        map.set(`fresh-${tier}`, { tokens: [now] });
      }

      Date.now = () => now;
      capturedFn!();

      for (const [map, tier] of maps) {
        expect(map.has(`stale-${tier}`)).toBe(false);
        expect(map.has(`fresh-${tier}`)).toBe(true);
        expect(rateLimitEvictions.render()).toContain(`{cause="empty",tier="${tier}"}`);
      }
    } finally {
      Date.now = realNow;
      startSpy.mockRestore();
      for (const [map] of maps) map.clear();
    }
  });
});
