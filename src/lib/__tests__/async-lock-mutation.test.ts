import { describe, expect, test } from "bun:test";

import { createKeyedMutex, reloadLiveCache } from "../async-lock.js";

// ---------------------------------------------------------------------------
// createKeyedMutex / reloadLiveCache — mutation-testing backstop for
// `src/lib/async-lock.ts`.
//
// createKeyedMutex() has no I/O -- it's pure Promise/Map bookkeeping -- but
// its correctness is entirely about *ordering*: same-key calls must run
// strictly one at a time in call order, different-key calls must never
// block each other, and the `locks.get(key) === lockEntry` check in the
// `finally` block must only clear the map entry when no later waiter has
// replaced it (clearing it early would let a brand-new call for that key
// bypass an in-flight queue).
//
// Every test below drives ordering with explicit, manually-resolved "gate"
// promises (never real sleeps) plus a shared `order` array of push()ed
// markers, so the exact interleaving of start/end events is asserted
// deterministically. `flush()` is a real macrotask boundary (setTimeout 0)
// used only to let all currently-pending microtasks (promise continuations)
// settle before the next assertion -- it does not depend on any timing
// value, so it isn't flaky.
// ---------------------------------------------------------------------------

/** Yields until all currently-queued microtasks have run. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** A promise plus its external resolver, for manually controlling when an fn body proceeds. */
function makeGate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((r) => {
    open = r;
  });
  return { promise, open };
}

describe("createKeyedMutex — single caller", () => {
  test("returns fn's resolved value and calls fn exactly once", async () => {
    const mutex = createKeyedMutex();
    let calls = 0;

    const result = await mutex.withLock("k", async () => {
      calls++;
      return 42;
    });

    expect(result).toBe(42);
    expect(calls).toBe(1);
  });

  test("propagates a rejection from fn and still releases the lock for the next caller", async () => {
    const mutex = createKeyedMutex();

    await expect(
      mutex.withLock("k", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    // If the lock weren't released in a `finally`, this would hang forever.
    const recovered = await mutex.withLock("k", async () => "recovered");
    expect(recovered).toBe("recovered");
  });
});

describe("createKeyedMutex — same key serializes strictly in call order", () => {
  test("a second call for the same key does not start until the first has fully finished", async () => {
    const mutex = createKeyedMutex();
    const order: string[] = [];
    const gateA = makeGate();
    const gateB = makeGate();

    const pA = mutex.withLock("k", async () => {
      order.push("A-start");
      await gateA.promise;
      order.push("A-end");
      return "A";
    });
    const pB = mutex.withLock("k", async () => {
      order.push("B-start");
      await gateB.promise;
      order.push("B-end");
      return "B";
    });

    await flush();
    // B must still be queued behind A -- only A has been allowed to start.
    expect(order).toEqual(["A-start"]);

    gateA.open();
    await flush();
    // B only starts once A's fn has fully resolved (not merely once A's
    // *predecessor* promise settled).
    expect(order).toEqual(["A-start", "A-end", "B-start"]);

    gateB.open();
    const [rA, rB] = await Promise.all([pA, pB]);
    expect(rA).toBe("A");
    expect(rB).toBe("B");
    expect(order).toEqual(["A-start", "A-end", "B-start", "B-end"]);
  });

  test("a rejection from the first caller still unblocks the second (queue isn't stuck)", async () => {
    const mutex = createKeyedMutex();
    const order: string[] = [];
    const gateA = makeGate();

    const pA = mutex
      .withLock("k", async () => {
        order.push("A-start");
        await gateA.promise;
        throw new Error("A failed");
      })
      .catch((err: unknown) => err);

    const pB = mutex.withLock("k", async () => {
      order.push("B-start");
      return "B";
    });

    await flush();
    expect(order).toEqual(["A-start"]);

    gateA.open();
    const [aOutcome, bResult] = await Promise.all([pA, pB]);
    expect(aOutcome).toBeInstanceOf(Error);
    expect(bResult).toBe("B");
    expect(order).toEqual(["A-start", "B-start"]);
  });
});

describe("createKeyedMutex — different keys never block each other", () => {
  test("a call for a different key runs and finishes while the first key's call is still pending", async () => {
    const mutex = createKeyedMutex();
    const order: string[] = [];
    const gateX = makeGate();

    const pX = mutex.withLock("keyX", async () => {
      order.push("X-start");
      await gateX.promise;
      order.push("X-end");
      return "X";
    });

    await flush();
    expect(order).toEqual(["X-start"]);

    const yResult = await mutex.withLock("keyY", async () => {
      order.push("Y-start");
      order.push("Y-end");
      return "Y";
    });

    // Y ran to completion entirely while X was still blocked on its gate.
    expect(yResult).toBe("Y");
    expect(order).toEqual(["X-start", "Y-start", "Y-end"]);

    gateX.open();
    const xResult = await pX;
    expect(xResult).toBe("X");
    expect(order).toEqual(["X-start", "Y-start", "Y-end", "X-end"]);
  });
});

describe("createKeyedMutex — queue-tail cleanup (locks.get(key) === lockEntry)", () => {
  test("a later caller for the same key cannot bypass an in-flight queue after an earlier release fires", async () => {
    const mutex = createKeyedMutex();
    const order: string[] = [];
    const gateA = makeGate();
    const gateB = makeGate();
    const gateC = makeGate();

    const pA = mutex.withLock("k", async () => {
      order.push("A-start");
      await gateA.promise;
      order.push("A-end");
      return "A";
    });
    const pB = mutex.withLock("k", async () => {
      order.push("B-start");
      await gateB.promise;
      order.push("B-end");
      return "B";
    });
    const pC = mutex.withLock("k", async () => {
      order.push("C-start");
      await gateC.promise;
      order.push("C-end");
      return "C";
    });

    await flush();
    expect(order).toEqual(["A-start"]);

    // Release A. At this point the map's live entry for "k" belongs to C
    // (the queue tail), not A -- A's own finally-block cleanup check must
    // see that mismatch and skip deleting the entry.
    gateA.open();
    await flush();
    expect(order).toEqual(["A-start", "A-end", "B-start"]);

    // A brand-new caller D arrives now, while B is mid-flight and C hasn't
    // even started. If A's cleanup had incorrectly deleted the queue-tail
    // entry (e.g. an unconditional/always-delete or inverted-condition
    // mutant), D would find no entry for "k" and run immediately,
    // interleaving with B/C instead of queuing behind them.
    let dRan = false;
    const pD = mutex.withLock("k", async () => {
      dRan = true;
      order.push("D-start");
      return "D";
    });

    await flush();
    expect(dRan).toBe(false);
    expect(order).toEqual(["A-start", "A-end", "B-start"]);

    gateB.open();
    await flush();
    expect(dRan).toBe(false);
    expect(order).toEqual(["A-start", "A-end", "B-start", "B-end", "C-start"]);

    gateC.open();
    const [rA, rB, rC, rD] = await Promise.all([pA, pB, pC, pD]);
    expect(rA).toBe("A");
    expect(rB).toBe("B");
    expect(rC).toBe("C");
    expect(rD).toBe("D");
    expect(order).toEqual(["A-start", "A-end", "B-start", "B-end", "C-start", "C-end", "D-start"]);
  });

  test("after a queue fully drains, a fresh call for the same key runs immediately (no leaked backlog)", async () => {
    const mutex = createKeyedMutex();

    const first = await mutex.withLock("k", async () => "first");
    expect(first).toBe("first");

    // If the drained entry were never cleaned up, this would still resolve
    // correctly (an already-settled predecessor is a no-op wait either way)
    // -- this test is a sanity check that draining doesn't corrupt later use
    // of the same key, not a cleanup-timing assertion by itself.
    const second = await mutex.withLock("k", async () => "second");
    expect(second).toBe("second");
  });
});

describe("reloadLiveCache", () => {
  test("clears existing entries and repopulates from populate(), returning the new size", () => {
    const cache = new Map<string, number>([["stale", 1]]);

    const size = reloadLiveCache(cache, (c) => {
      c.set("a", 1);
      c.set("b", 2);
    });

    expect(size).toBe(2);
    expect(cache.size).toBe(2);
    expect(cache.has("stale")).toBe(false);
    expect(cache.get("a")).toBe(1);
    expect(cache.get("b")).toBe(2);
  });

  test("populate() is invoked with the SAME map instance, not a copy", () => {
    const cache = new Map<string, string>();
    let sameInstance = false;

    reloadLiveCache(cache, (c) => {
      sameInstance = c === cache;
      c.set("k", "v");
    });

    expect(sameInstance).toBe(true);
    expect(cache.get("k")).toBe("v");
  });

  test("clear() runs before populate() -- a stale key is already gone by the time populate observes it", () => {
    const cache = new Map<string, number>([["stale", 99]]);
    let hadStaleDuringPopulate: boolean | undefined;

    reloadLiveCache(cache, (c) => {
      hadStaleDuringPopulate = c.has("stale");
    });

    expect(hadStaleDuringPopulate).toBe(false);
  });

  test("returns 0 when populate() adds nothing", () => {
    const cache = new Map<string, number>([["stale", 1]]);

    const size = reloadLiveCache(cache, () => {
      // intentionally adds nothing
    });

    expect(size).toBe(0);
    expect(cache.size).toBe(0);
  });

  test("returns exactly cache.size for a larger repopulation (not a hardcoded/off-by-one value)", () => {
    const cache = new Map<number, string>();

    const size = reloadLiveCache(cache, (c) => {
      for (let i = 0; i < 5; i++) {
        c.set(i, `v${i}`);
      }
    });

    expect(size).toBe(5);
  });
});
