/**
 * Stryker mutation-testing backstop for src/tool-policies/response-cache.ts.
 * Baseline 77.11% (64/83) — the existing response-cache.test.ts (src/proxy/__tests__/,
 * a cross-directory test location) covers config persistence and the proxy-integration
 * happy paths fully, but misses: the TTL <= vs < boundary, expiresAt's * vs / TTL
 * arithmetic, the LRU-eviction loop's defensive `oldest === undefined` guard,
 * purgeClientCache (had ZERO coverage at all), stableStringify's null/undefined/
 * primitive/array edge cases (only ever exercised with plain objects and numbers),
 * __resetCacheForTesting's own effect, and __setClockForTesting(null)'s real-clock
 * fallback.
 *
 * 86:27-86:43 ArrowFunction [Survived] `() => undefined` on `nowFn`'s initial module-
 * load declaration (`let nowFn: () => number = () => Date.now();`) is a DOCUMENTED
 * EQUIVALENT — the same DI-helper-initial-value class already found on
 * load-balancer.ts's `nowFn` and quarantine.ts's cooldown clock. Every test file that
 * touches this module (this one and response-cache.test.ts) resets the clock via
 * `__setClockForTesting(null)` in its own `beforeEach`, which reassigns `nowFn` to a
 * NEW (structurally identical) arrow function before the first assertion of the first
 * test ever runs. Since `bun test` runs every file in one process, once ANY test file
 * has run once, the original module-load-time declaration is permanently unreachable
 * for the rest of the process. Not chased.
 *
 * 114:47-118:4 BlockStatement [Timeout] on cacheSet's LRU-eviction `while` loop body
 * emptied — a genuine infinite loop (Stryker's own timeout detection is the kill
 * signal, same "detected via timeout" convention used throughout this program). Not
 * chased with a dedicated test.
 *
 * SURPRISING DISCOVERY, unrelated to any mutant: cacheKey's "space-joined" doc
 * comment (line ~89) is stale — the actual field separator in the template
 * literals (cacheKey, purgeToolCache's and purgeClientCache's `prefix`) is a
 * literal NUL byte (`\0`/`\x00`), not an ASCII space. Confirmed via `od -c` / a
 * raw Python byte read; the file has been binary in git's own eyes
 * (`file src/tool-policies/response-cache.ts` -> "data") since its very first
 * commit (`2dcd096`, `git show 2dcd096 --stat` reports "Bin 0 -> 6212 bytes").
 * Functionally harmless — these keys are process-local, in-memory-only, never
 * persisted or compared across processes, and NUL is at least as safe a
 * separator as space — but every exact-string assertion below must use `\0`,
 * not a space, to match the REAL current behavior. Flagged to the user as a
 * doc/hygiene mismatch worth a separate look; not fixed here (out of scope for
 * a test-only mutation backstop pass).
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { config } from "../../config.js";
import {
  cacheKey,
  cacheGet,
  cacheSet,
  cacheSize,
  purgeClientCache,
  __resetCacheForTesting,
  __setClockForTesting,
} from "../response-cache.js";

beforeEach(() => {
  __resetCacheForTesting();
  __setClockForTesting(null);
});
afterEach(() => {
  __resetCacheForTesting();
  __setClockForTesting(null);
});

// 101:7-101:33 EqualityOperator [Survived] `entry.expiresAt < nowFn()` (real: `<=`).
// An entry read at the EXACT tick it expires must be treated as expired.
describe("cacheGet — TTL expiry boundary is <=, not <", () => {
  test("an entry read at exactly its expiresAt tick is expired", () => {
    __setClockForTesting(() => 1000);
    cacheSet("k", { content: [{ type: "text", text: "v" }] }, 1); // expiresAt = 2000
    __setClockForTesting(() => 2000);
    expect(cacheGet("k")).toBeNull();
  });
});

// 112:48-112:65 ArithmeticOperator [Survived] `ttlSeconds / 1000` (real: `* 1000`).
// A 100s TTL must still be live 50ms later; the mutant's near-zero expiresAt
// (100/1000 = 0.1ms offset) would already have expired by then.
describe("cacheSet — expiresAt uses ttlSeconds * 1000, not / 1000", () => {
  test("a 100s TTL entry is still live 50ms after being set", () => {
    __setClockForTesting(() => 1_000_000);
    cacheSet("k", { content: [{ type: "text", text: "v" }] }, 100);
    __setClockForTesting(() => 1_000_050);
    expect(cacheGet("k")).not.toBeNull();
  });
});

// 116:9-116:29 ConditionalExpression [Survived] false (`if (oldest === undefined)
// break;` forced false). Only reachable once the store is fully drained mid-loop,
// which needs a below-zero cacheMaxEntries — forcing the guard off turns the
// now-permanently-true `store.size > cacheMaxEntries` loop condition into an
// infinite `store.delete(undefined)` spin once the map is empty. Confirmed via
// a verify run: this test resolves the mutant as a genuine Timeout (same
// "detected via timeout" convention as the block-emptied mutant above), not a
// Killed status — real code drains to empty and returns instantly either way.
describe("cacheSet — LRU eviction loop terminates once the store is fully drained", () => {
  test("a negative cacheMaxEntries evicts down to empty and returns, without hanging", () => {
    const orig = config.cacheMaxEntries;
    (config as Record<string, unknown>).cacheMaxEntries = -1;
    try {
      cacheSet("k", { content: [] }, 60);
      expect(cacheSize()).toBe(0);
    } finally {
      (config as Record<string, unknown>).cacheMaxEntries = orig;
    }
  });
});

// 130:60-135:2 BlockStatement, 131:18-131:34 StringLiteral, 132:35-134:4 BlockStatement,
// 133:9-133:31 ConditionalExpression (x2) + MethodExpression [all Survived] —
// purgeClientCache had ZERO prior test coverage. One client's entries must be
// dropped; an UNRELATED client's entries must survive (proves both the emptied-body/
// emptied-prefix mutants, which purge nothing or everything, and the startsWith<->
// endsWith swap, which purges nothing since no real key ends with a "client "
// prefix).
describe("purgeClientCache — drops only that client's entries, not another's", () => {
  test("client c1's keys are gone; client c2's keys are untouched", () => {
    const k1 = cacheKey("c1", "t", "http://u", {});
    const k2 = cacheKey("c2", "t", "http://u", {});
    cacheSet(k1, { content: [{ type: "text", text: "a" }] }, 60);
    cacheSet(k2, { content: [{ type: "text", text: "b" }] }, 60);
    purgeClientCache("c1");
    expect(cacheGet(k1)).toBeNull();
    expect(cacheGet(k2)).not.toBeNull();
  });
});

// 144:7-144:21 ConditionalExpression [Survived] false (`value === null || typeof
// value !== "object"` forced false, on stableStringify's primitive/null guard).
// Bypassing the guard for a null or primitive nested arg value falls through to
// `Object.keys(...)`, which THROWS for null and silently produces `{}` for a number
// — both diverge sharply from the real short-circuited output.
describe("cacheKey — a null-valued arg does not throw and serializes as null", () => {
  test("a null property value round-trips through stableStringify without throwing", () => {
    expect(() => cacheKey("c", "t", "http://u", { a: null })).not.toThrow();
    expect(cacheKey("c", "t", "http://u", { a: null })).toBe('c\0t\0http://u\0{"a":null}');
  });
});
describe("cacheKey — a primitive (non-object, non-null) arg value serializes directly", () => {
  test("a number property value serializes as its own JSON literal, not {}", () => {
    expect(cacheKey("c", "t", "http://u", { a: 5 })).toBe('c\0t\0http://u\0{"a":5}');
  });
});

// 144:84-144:90 StringLiteral [Survived] `""` (the `?? "null"` fallback on
// `JSON.stringify(value) ?? "null"`, emptied). Only observable when
// JSON.stringify(value) itself is `undefined` — an explicit `undefined`-valued
// property (still an own enumerable key, so Object.keys includes it).
describe('cacheKey — an undefined-valued arg falls back to the string "null"', () => {
  test("an explicit undefined property value renders as null, not an empty gap", () => {
    expect(cacheKey("c", "t", "http://u", { a: undefined })).toBe('c\0t\0http://u\0{"a":null}');
  });
});

// 145:7-145:27 ConditionalExpression [Survived] false (Array.isArray(value) forced
// false), 145:36-145:79 StringLiteral [Survived] (the whole array-branch template
// emptied to ""), 145:72-145:75 StringLiteral [Survived] `""` (the "," element
// separator dropped). One exact-string assertion on a 2-element array kills all
// three: forced-false renders `{"0":1,"1":2}` instead of `[1,2]`; the emptied
// template renders `` instead of `[1,2]`; the dropped comma renders `[12]`.
describe("cacheKey — an array-valued arg serializes with brackets and comma separators", () => {
  test("a 2-element array renders as [1,2], not an object, not empty, not [12]", () => {
    expect(cacheKey("c", "t", "http://u", { a: [1, 2] })).toBe('c\0t\0http://u\0{"a":[1,2]}');
  });
});

// 148:86-148:89 StringLiteral [Survived] `""` — NOT the ":" key/value separator
// (a single-key test can't reach this: with only one entry, `.join(",")` has
// nothing to join). This is the OUTER object branch's `.join(",")` separator
// between MULTIPLE key:value pairs, dropped — needs a 2+ key object to observe.
describe("cacheKey — multiple object properties are comma-separated", () => {
  test('a 2-key object arg renders {"a":1,"b":2}, not {"a":1"b":2}', () => {
    expect(cacheKey("c", "t", "http://u", { a: 1, b: 2 })).toBe('c\0t\0http://u\0{"a":1,"b":2}');
  });
});

// 152:48-154:2 BlockStatement [Survived] (`store.clear();` emptied) —
// __resetCacheForTesting had no test asserting its own effect; every other test
// merely relies on it as inert setup.
describe("__resetCacheForTesting — actually clears the store", () => {
  test("a populated store is empty after reset", () => {
    cacheSet("k", { content: [] }, 60);
    expect(cacheSize()).toBe(1);
    __resetCacheForTesting();
    expect(cacheSize()).toBe(0);
  });
});

// 158:18-158:34 ArrowFunction [Survived] `() => undefined` (the `?? (() => Date.now())`
// fallback inside __setClockForTesting, emptied to a function returning undefined).
// Only observable by forcing an entry's expiresAt far into the past via a stubbed
// clock, then calling __setClockForTesting(null) and reading with the REAL clock:
// real code expires it (`expiresAt <= Date.now()`); the mutant's `nowFn() ===
// undefined` makes every `<=` comparison false, so the entry would incorrectly
// never expire.
describe("__setClockForTesting(null) — restores a real, ticking clock", () => {
  test("an entry set far in the past expires once the real clock is restored", () => {
    __setClockForTesting(() => 0);
    cacheSet("k", { content: [] }, 1); // expiresAt = 1000 (epoch ms), long past by now
    __setClockForTesting(null);
    expect(cacheGet("k")).toBeNull();
  });
});
