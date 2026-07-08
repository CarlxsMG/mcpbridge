/**
 * Stryker mutation-testing backstop for src/db/rate-counters.ts — had no
 * dedicated test file at all.
 *
 * Documented equivalent (not chased further): 46:7-46:16 UpdateOperator
 * (`++opCount` flipped to `--opCount`). Verified empirically (`bun -e`,
 * simulating 1000 calls from several arbitrary starting offsets): a
 * counter incrementing vs. decrementing by 1 crosses a multiple of 200
 * with the EXACT SAME FREQUENCY (once per 200 calls) regardless of
 * direction or starting value — any 200 consecutive integers, traversed in
 * either direction, contain exactly one multiple of 200. Since `opCount`
 * is a module-private variable with no exported getter, and its only
 * observable effect is via `% 200 === 0`'s prune trigger, there is no
 * black-box test that can distinguish the two directions.
 */
import { describe, test, expect, spyOn } from "bun:test";
import { checkSharedRateLimit, checkSharedToolRateLimit, checkSharedEndUserRateLimit } from "../../db/rate-counters.js";
import { getDb, __resetDbForTesting } from "../../db/connection.js";

// 46:7-46:28 EqualityOperator [Survived] (`++opCount % 200 === 0` flipped to
// `!== 0`). Verified via `spyOn` on the real sqlite Database instance's
// `.query` method (calls through, just records invocations — confirmed
// empirically). Any 200 CONSECUTIVE calls contain exactly one multiple of
// 200 regardless of opCount's starting offset, so this is deterministic
// without needing to know or reset the module-level counter.
describe("checkSharedRateLimit — opportunistic pruning", () => {
  test("prunes old windows exactly once per 200 calls, not on every call", () => {
    __resetDbForTesting();
    const db = getDb();
    const querySpy = spyOn(db, "query");
    try {
      for (let i = 0; i < 200; i++) {
        checkSharedRateLimit(`prune-key-${i}`, 1000, 60_000, Date.now());
      }
      const deleteCalls = querySpy.mock.calls.filter(
        (call) => typeof call[0] === "string" && call[0].includes("DELETE FROM rate_counters"),
      );
      expect(deleteCalls.length).toBe(1);
    } finally {
      querySpy.mockRestore();
    }
  });

  // 50:19-50:37 EqualityOperator [Survived] (`row.count <= limit` flipped to
  // `<`). A request that lands EXACTLY on the limit must still be allowed.
  test("a request that reaches exactly the limit is allowed (<=, not <)", () => {
    __resetDbForTesting();
    const result = checkSharedRateLimit("boundary-key", 1, 60_000, Date.now());
    expect(result.count).toBe(1);
    expect(result.allowed).toBe(true);
  });

  // 47:70-47:92 ArithmeticOperator [Survived] (`windowStart - windowMs`
  // flipped to `+`). The prune must delete only windows OLDER than the one
  // immediately before the current window — never the current window's own
  // row. Fixing `now` across all 200 calls keeps windowStart constant, so
  // whichever call happens to trip the prune uses the SAME DELETE
  // parameter, making the exact row-survival outcome deterministic
  // regardless of the module-level opCount's unknown starting offset.
  test("the prune never deletes the current window's own row, only windows older than the previous one", () => {
    __resetDbForTesting();
    const windowMs = 60_000;
    const t = Math.floor(Date.now() / windowMs) * windowMs; // exact window boundary

    checkSharedRateLimit("row-b-current-window", 1000, windowMs, t); // seeds the CURRENT window, count=1
    checkSharedRateLimit("row-c-two-windows-ago", 1000, windowMs, t - 2 * windowMs); // must be pruned

    for (let i = 0; i < 200; i++) {
      checkSharedRateLimit(`prune-key-2-${i}`, 1000, windowMs, t);
    }

    // Real code: only "row-c" (two windows old) was pruned. "row-b" (the
    // CURRENT window) must be untouched — its count continues from 1, not
    // reset to 1 by a delete-and-recreate.
    const again = checkSharedRateLimit("row-b-current-window", 1000, windowMs, t);
    expect(again.count).toBe(2);
  });

  // 51:65-51:102 ArithmeticOperator [Survived] (`/1000` flipped to `*1000`)
  // / 51:66-51:88 ArithmeticOperator [Survived] (`windowStart + windowMs`
  // flipped to `-`). `now` is directly injectable, so windowStart is fully
  // controlled — an exact expected value (hand-computed) catches either
  // arithmetic flip, which each produce wildly different (not just
  // slightly off) numbers.
  test("computes the exact retryAfterSeconds from windowStart/windowMs/now", () => {
    __resetDbForTesting();
    const windowMs = 60_000;
    const now = 10_000; // windowStart = floor(10_000 / 60_000) * 60_000 = 0
    checkSharedRateLimit("retry-exact-key", 1, windowMs, now); // 1st call fills the limit of 1
    const blocked = checkSharedRateLimit("retry-exact-key", 1, windowMs, now);
    expect(blocked.allowed).toBe(false);
    // Real: ceil((0 + 60_000 - 10_000) / 1000) = 50.
    expect(blocked.retryAfterSeconds).toBe(50);
  });
});

// 61:34-61:51 StringLiteral [Survived] (the `` `tool:${toolKey}` ``
// template literal collapsed to an empty string — every tool would
// collapse onto ONE shared counter row regardless of its real key).
describe("checkSharedToolRateLimit", () => {
  test("two different tool keys do not share a counter", () => {
    __resetDbForTesting();
    const a = checkSharedToolRateLimit("tool-a-unique", 1, Date.now());
    const b = checkSharedToolRateLimit("tool-b-unique", 1, Date.now());
    expect(a.allowed).toBe(true);
    expect(b.allowed).toBe(true);
  });
});

// 78:10-78:72 ObjectLiteral [Survived] (`{ allowed: r.allowed,
// retryAfterSeconds: r.retryAfterSeconds }` emptied to `{}` — had no test
// calling this function at all).
describe("checkSharedEndUserRateLimit", () => {
  test("returns the exact {allowed, retryAfterSeconds} shape", () => {
    __resetDbForTesting();
    const result = checkSharedEndUserRateLimit(1, "end-user-unique", 1, Date.now());
    expect(result).toEqual({ allowed: true, retryAfterSeconds: 0 });
  });
});
