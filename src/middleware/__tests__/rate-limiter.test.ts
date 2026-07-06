import { describe, test, expect } from "bun:test";
import { _internalsForTesting } from "../../middleware/rate-limiter.js";

// ---------------------------------------------------------------------------
// Rate-limiter — LRU eviction regression tests
//
// Bug detected: without LRU eviction the globalBuckets Map would grow
// without bound.  A plain Map evicts the oldest *insertion* order entry;
// a proper LRU must track *access* recency.
// ---------------------------------------------------------------------------

const { lruGet, lruSet } = _internalsForTesting;

// Use a fresh isolated Map per test so tests are fully independent.
function freshMap(): Map<string, { tokens: number[] }> {
  return new Map();
}

describe("rate-limiter LRU — basic eviction", () => {
  test("inserting a 4th key evicts the LRU (first-inserted) key when maxSize=3", () => {
    const map = freshMap();
    const max = 3;

    lruSet(map, "a", { tokens: [] }, max);
    lruSet(map, "b", { tokens: [] }, max);
    lruSet(map, "c", { tokens: [] }, max);
    lruSet(map, "d", { tokens: [] }, max); // should evict "a"

    expect(map.has("a")).toBe(false); // evicted
    expect(map.has("b")).toBe(true);
    expect(map.has("c")).toBe(true);
    expect(map.has("d")).toBe(true);
  });

  test("accessing 'a' promotes it; inserting 'd' evicts 'b' instead", () => {
    const map = freshMap();
    const max = 3;

    lruSet(map, "a", { tokens: [] }, max);
    lruSet(map, "b", { tokens: [] }, max);
    lruSet(map, "c", { tokens: [] }, max);

    // Access "a" — promotes it to most-recently-used
    lruGet(map, "a");

    // Now LRU order (oldest first): b, c, a
    // Inserting "d" should evict "b"
    lruSet(map, "d", { tokens: [] }, max);

    expect(map.has("b")).toBe(false); // evicted
    expect(map.has("a")).toBe(true);
    expect(map.has("c")).toBe(true);
    expect(map.has("d")).toBe(true);
  });
});

describe("rate-limiter LRU — lruGet promote semantics", () => {
  test("lruGet returns undefined for missing key", () => {
    const map = freshMap();
    expect(lruGet(map, "missing")).toBeUndefined();
  });

  test("lruGet returns the bucket for an existing key", () => {
    const map = freshMap();
    const bucket = { tokens: [1, 2, 3] };
    lruSet(map, "x", bucket, 10);
    const got = lruGet(map, "x");
    expect(got).toBeDefined();
    expect(got!.tokens).toEqual([1, 2, 3]);
  });

  test("lruGet moves key to end so a later insertion evicts a different key", () => {
    const map = freshMap();
    const max = 2;

    lruSet(map, "first", { tokens: [] }, max);
    lruSet(map, "second", { tokens: [] }, max);

    // Promote "first" — LRU becomes "second"
    lruGet(map, "first");

    // Insert third key — "second" should be evicted, not "first"
    lruSet(map, "third", { tokens: [] }, max);

    expect(map.has("second")).toBe(false);
    expect(map.has("first")).toBe(true);
    expect(map.has("third")).toBe(true);
  });
});
