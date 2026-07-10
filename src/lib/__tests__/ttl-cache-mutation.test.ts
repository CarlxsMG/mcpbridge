import { describe, expect, test, spyOn } from "bun:test";

import { createTtlCache } from "../ttl-cache.js";

// ---------------------------------------------------------------------------
// createTtlCache — mutation-testing backstop for `src/lib/ttl-cache.ts`.
//
// The factory has one piece of internal state (`cached: { value, fetchedAt,
// ttlMs } | null`) and two operations: `get()` (return cached value if fresh,
// otherwise await fetchFn and recache) and `reset()` (drop the cached
// value). Every test drives time via an injected `nowFn` (a plain mutable
// counter) rather than real Date.now/setTimeout, so TTL-boundary behavior is
// exact and instant. The one test that intentionally omits `nowFn` verifies
// the real-clock default via `spyOn(Date, "now")`.
// ---------------------------------------------------------------------------

/** Deterministic clock: `nowFn` reads a mutable box the test controls directly. */
function makeClock(initial: number) {
  let current = initial;
  return {
    nowFn: (): number => current,
    set(value: number): void {
      current = value;
    },
  };
}

describe("createTtlCache — cache miss / first fetch", () => {
  test("calls fetchFn on the first get() and returns its resolved value", async () => {
    let calls = 0;
    const cache = createTtlCache<string>(
      async () => {
        calls++;
        return "v1";
      },
      1000,
      { nowFn: () => 0 },
    );

    const result = await cache.get();

    expect(result).toBe("v1");
    expect(calls).toBe(1);
  });

  test("passes the given arg through to fetchFn on a miss", async () => {
    const seen: string[] = [];
    const cache = createTtlCache<string, string>(
      async (arg) => {
        seen.push(arg);
        return `fetched:${arg}`;
      },
      1000,
      { nowFn: () => 0 },
    );

    const result = await cache.get("hello");

    expect(result).toBe("fetched:hello");
    expect(seen).toEqual(["hello"]);
  });
});

describe("createTtlCache — freshness (within ttlMs)", () => {
  test("returns the cached value without refetching while still within ttlMs", async () => {
    const clock = makeClock(1000);
    let calls = 0;
    const cache = createTtlCache<number>(
      async () => {
        calls++;
        return calls;
      },
      1000,
      { nowFn: clock.nowFn },
    );

    const first = await cache.get();
    expect(first).toBe(1);

    clock.set(1500); // elapsed 500 < ttlMs 1000 -> still fresh
    const second = await cache.get();

    expect(second).toBe(1);
    expect(calls).toBe(1);
  });

  test("ignores a different arg passed on a cache hit", async () => {
    const clock = makeClock(1000);
    const seen: string[] = [];
    const cache = createTtlCache<string, string>(
      async (arg) => {
        seen.push(arg);
        return `v:${arg}`;
      },
      1000,
      { nowFn: clock.nowFn },
    );

    const first = await cache.get("a");
    expect(first).toBe("v:a");

    clock.set(1200); // still fresh
    const second = await cache.get("b");

    expect(second).toBe("v:a"); // "b" never reached fetchFn
    expect(seen).toEqual(["a"]);
  });
});

describe("createTtlCache — staleness / TTL boundary", () => {
  test("does not refetch when elapsed is exactly one less than ttlMs", async () => {
    const clock = makeClock(1000);
    let calls = 0;
    const cache = createTtlCache<number>(
      async () => {
        calls++;
        return calls;
      },
      1000,
      { nowFn: clock.nowFn },
    );

    await cache.get(); // fetchedAt = 1000

    clock.set(1999); // elapsed 999 < ttlMs 1000
    const second = await cache.get();

    expect(second).toBe(1);
    expect(calls).toBe(1);
  });

  test("refetches when elapsed exactly equals ttlMs (upper boundary is exclusive)", async () => {
    const clock = makeClock(1000);
    let calls = 0;
    const cache = createTtlCache<number>(
      async () => {
        calls++;
        return calls;
      },
      1000,
      { nowFn: clock.nowFn },
    );

    await cache.get(); // fetchedAt = 1000

    clock.set(2000); // elapsed exactly 1000 == ttlMs -> stale
    const second = await cache.get();

    expect(second).toBe(2);
    expect(calls).toBe(2);
  });

  test("refetches when elapsed exceeds ttlMs", async () => {
    const clock = makeClock(1000);
    let calls = 0;
    const cache = createTtlCache<number>(
      async () => {
        calls++;
        return calls;
      },
      1000,
      { nowFn: clock.nowFn },
    );

    await cache.get();

    clock.set(5000); // elapsed 4000 >> ttlMs 1000
    const second = await cache.get();

    expect(second).toBe(2);
    expect(calls).toBe(2);
  });
});

describe("createTtlCache — reset()", () => {
  test("forces the next get() to refetch even though still within ttlMs", async () => {
    const clock = makeClock(1000);
    let calls = 0;
    const cache = createTtlCache<number>(
      async () => {
        calls++;
        return calls;
      },
      10_000,
      { nowFn: clock.nowFn },
    );

    await cache.get();

    clock.set(1100); // well within the 10s ttl
    cache.reset();
    const second = await cache.get();

    expect(second).toBe(2);
    expect(calls).toBe(2);
  });
});

describe("createTtlCache — function-based ttlMs", () => {
  test("calls the ttlMs function with the freshly fetched value and uses its return as the ttl", async () => {
    const clock = makeClock(1000);
    let calls = 0;
    const seenValues: number[] = [];
    const cache = createTtlCache<number>(
      async () => {
        calls++;
        return calls * 100;
      },
      (value) => {
        seenValues.push(value);
        return 500;
      },
      { nowFn: clock.nowFn },
    );

    const first = await cache.get();
    expect(first).toBe(100);
    expect(seenValues).toEqual([100]); // called with the fetched value, not e.g. undefined

    clock.set(1400); // elapsed 400 < the function-derived ttl of 500 -> still fresh
    const second = await cache.get();
    expect(second).toBe(100);
    expect(calls).toBe(1);

    clock.set(1600); // elapsed 600 >= 500 -> stale, refetch
    const third = await cache.get();
    expect(third).toBe(200);
    expect(calls).toBe(2);
    expect(seenValues).toEqual([100, 200]); // recomputed from the NEW fetched value on refetch
  });
});

describe("createTtlCache — failed fetchFn", () => {
  test("a rejection propagates and leaves the previously cached value untouched", async () => {
    const clock = makeClock(1000);
    let calls = 0;
    let shouldFail = false;
    const cache = createTtlCache<string>(
      async () => {
        calls++;
        if (shouldFail) throw new Error("boom");
        return `v${calls}`;
      },
      1000,
      { nowFn: clock.nowFn },
    );

    const first = await cache.get();
    expect(first).toBe("v1"); // fetchedAt = 1000

    clock.set(2500); // elapsed 1500 > ttlMs 1000 -> stale, attempt refetch
    shouldFail = true;
    await expect(cache.get()).rejects.toThrow("boom");
    expect(calls).toBe(2); // the failed attempt did happen

    shouldFail = false;
    clock.set(1300); // relative to the ORIGINAL fetchedAt (1000): elapsed 300 < ttlMs 1000
    const stillCached = await cache.get();

    expect(stillCached).toBe("v1"); // proves fetchedAt/value were never overwritten by the failed attempt
    expect(calls).toBe(2); // no new fetch happened -- served from the untouched cache entry
  });
});

describe("createTtlCache — default clock (opts.nowFn omitted)", () => {
  test("uses the real Date.now when nowFn is not provided", async () => {
    const dateSpy = spyOn(Date, "now").mockReturnValue(123_456_789);
    try {
      const cache = createTtlCache<string>(async () => "v1", 1000);
      const result = await cache.get();

      expect(result).toBe("v1");
      expect(dateSpy).toHaveBeenCalled();
    } finally {
      dateSpy.mockRestore();
    }
  });
});
