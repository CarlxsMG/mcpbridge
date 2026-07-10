/**
 * Stryker mutation-testing backstop for src/admin/entities/consumers.ts.
 *
 * Gap-fills what the hand-written consumers.test.ts doesn't exercise:
 * `isValidQuotaValue` (never imported there at all), `consumerNameExists`,
 * `getConsumerByName`, `getConsumer`'s non-integer-id guard, `updateConsumer`'s
 * partial-update / nonexistent-id paths, `deleteConsumer`'s nonexistent-id
 * path, `checkConsumerQuota`/`checkEndUserRateLimit`'s optional explicit
 * `consumer` parameter (avoids a second db fetch) plus their unknown-consumer
 * fail-open path, and the end-user-id 256-char truncation boundary.
 */
import { describe, test, expect, beforeEach } from "bun:test";
import { __resetDbForTesting } from "../../../db/connection.js";
import {
  isValidQuotaValue,
  consumerNameExists,
  getConsumerByName,
  getConsumer,
  createConsumer,
  updateConsumer,
  deleteConsumer,
  checkConsumerQuota,
  checkEndUserRateLimit,
  type Consumer,
} from "../../../admin/entities/consumers.js";

beforeEach(() => {
  __resetDbForTesting();
});

describe("isValidQuotaValue", () => {
  test("null and undefined are valid (unlimited/disabled)", () => {
    expect(isValidQuotaValue(null)).toBe(true);
    expect(isValidQuotaValue(undefined)).toBe(true);
  });

  test("a positive integer is valid", () => {
    expect(isValidQuotaValue(5)).toBe(true);
    expect(isValidQuotaValue(1)).toBe(true);
  });

  test("zero is invalid -- must be strictly positive", () => {
    expect(isValidQuotaValue(0)).toBe(false);
  });

  test("a negative integer is invalid", () => {
    expect(isValidQuotaValue(-1)).toBe(false);
  });

  test("a non-integer number is invalid", () => {
    expect(isValidQuotaValue(1.5)).toBe(false);
  });

  test("a numeric-looking string is invalid -- typeof must genuinely be number", () => {
    expect(isValidQuotaValue("5")).toBe(false);
  });
});

describe("consumerNameExists", () => {
  test("true for an existing name, false for one that doesn't exist", () => {
    createConsumer({ name: "team-exists", monthlyQuota: null, actor: null });
    expect(consumerNameExists("team-exists")).toBe(true);
    expect(consumerNameExists("team-does-not-exist")).toBe(false);
  });
});

describe("getConsumerByName", () => {
  test("returns the matching consumer, or null when no row matches", () => {
    const c = createConsumer({ name: "team-by-name", monthlyQuota: 7, actor: null });
    const found = getConsumerByName("team-by-name");
    expect(found?.id).toBe(c.id);
    expect(found?.monthlyQuota).toBe(7);
    expect(getConsumerByName("no-such-team")).toBeNull();
  });
});

describe("getConsumer", () => {
  test("rejects a non-integer id up front, even one sqlite's loose binding would otherwise coerce into a match", () => {
    const c = createConsumer({ name: "team-a", monthlyQuota: null, actor: null });
    expect(c.id).toBe(1); // first row in this fresh in-memory db -- `true` below coerces to 1 in sqlite
    expect(getConsumer(true as unknown as number)).toBeNull();
    expect(getConsumer(1.5)).toBeNull();
    expect(getConsumer(NaN)).toBeNull();
  });

  test("returns null for a well-formed but nonexistent id", () => {
    expect(getConsumer(999999)).toBeNull();
  });
});

describe("updateConsumer", () => {
  test("returns null for a nonexistent id", () => {
    expect(updateConsumer(999999, { name: "ghost" })).toBeNull();
  });

  test("a name-only update leaves monthlyQuota and endUserRateLimitPerMin untouched", () => {
    const c = createConsumer({ name: "team-a", monthlyQuota: 42, endUserRateLimitPerMin: 9, actor: null });
    const updated = updateConsumer(c.id, { name: "team-a-renamed" });
    expect(updated?.name).toBe("team-a-renamed");
    expect(updated?.monthlyQuota).toBe(42);
    expect(updated?.endUserRateLimitPerMin).toBe(9);
  });
});

describe("deleteConsumer", () => {
  test("returns false for a nonexistent id", () => {
    expect(deleteConsumer(999999)).toBe(false);
  });
});

describe("checkConsumerQuota", () => {
  test("an unknown consumer (no explicit consumer passed) fails open with a null quota, not a throw", () => {
    const status = checkConsumerQuota(999999);
    expect(status.exceeded).toBe(false);
    expect(status.used).toBe(0);
    expect(status.quota).toBeNull();
  });

  test("the default (undefined) consumer param genuinely triggers its own db fetch, not a silent no-op", () => {
    const c = createConsumer({ name: "team-a", monthlyQuota: 5, actor: null });
    expect(checkConsumerQuota(c.id).quota).toBe(5);
  });

  test("an explicitly passed consumer is used as-is, without a second db fetch for a nonexistent one", () => {
    const fake: Consumer = {
      id: 4242424,
      name: "ghost",
      monthlyQuota: 1,
      endUserRateLimitPerMin: null,
      createdAt: 0,
      updatedAt: 0,
      createdBy: null,
    };
    // consumerId 4242424 doesn't exist in the db at all -- if the passed
    // `consumer` were ignored in favor of a fresh getConsumer() lookup, this
    // would come back as an unlimited/null-quota status instead of quota: 1.
    const status = checkConsumerQuota(4242424, fake);
    expect(status.quota).toBe(1);
    expect(status.exceeded).toBe(false); // 0 calls logged against a nonexistent key_id
  });
});

describe("checkEndUserRateLimit", () => {
  test("an explicitly passed consumer is used as-is, without a second db fetch for a nonexistent one", () => {
    const fake: Consumer = {
      id: 4242425,
      name: "ghost2",
      monthlyQuota: null,
      endUserRateLimitPerMin: 1,
      createdAt: 0,
      updatedAt: 0,
      createdBy: null,
    };
    // If the passed `consumer` were ignored in favor of a fresh
    // getConsumer(4242425) lookup (null, since it doesn't exist), this would
    // fail open (never limited) instead of actually enforcing the limit.
    expect(checkEndUserRateLimit(fake.id, "carol", fake).limited).toBe(false);
    expect(checkEndUserRateLimit(fake.id, "carol", fake).limited).toBe(true);
  });

  test("truncates the caller-asserted end-user id to 256 chars before bucketing", () => {
    const c = createConsumer({ name: "team-a", monthlyQuota: null, endUserRateLimitPerMin: 1, actor: null });
    const idA = "a".repeat(300);
    const idB = "a".repeat(256) + "z".repeat(44); // identical first 256 chars, diverges only after

    expect(checkEndUserRateLimit(c.id, idA).limited).toBe(false); // 1st call under idA's bucket
    expect(checkEndUserRateLimit(c.id, idA).limited).toBe(true); // 2nd call exceeds the limit of 1

    // idB shares idA's bucket once both are truncated to the same 256-char
    // prefix, so it's already over the limit -- if the truncation were ever
    // dropped, idB would land in a fresh bucket of its own instead.
    expect(checkEndUserRateLimit(c.id, idB).limited).toBe(true);
  });
});
