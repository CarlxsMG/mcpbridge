/**
 * Finding #21: getConsumerUsageThisMonth reads the incrementally-maintained
 * consumer_usage_counters row (kept in sync by recordUsage) instead of a
 * COUNT(*) scan over tool_call_log. Verifies the counter is driven by
 * recordUsage, is scoped per-consumer, and ignores unattributed/consumerless
 * calls.
 */
import { describe, test, expect, beforeEach } from "bun:test";
import { __resetDbForTesting } from "../../../db/connection.js";
import { createConsumer, getConsumerUsageThisMonth, checkConsumerQuota } from "../consumers.js";
import { recordUsage } from "../../../observability/usage.js";
import { createMcpKey } from "../../../security/mcp-key-store.js";

function record(keyId: number | null): void {
  recordUsage({
    clientName: "svc",
    toolName: "get-users",
    keyId,
    statusClass: "2xx",
    isError: false,
    durationMs: 5,
  });
}

beforeEach(() => {
  __resetDbForTesting();
});

describe("consumer usage counter (#21)", () => {
  test("recordUsage increments the O(1) counter for a consumer's key", () => {
    const c = createConsumer({ name: "team-a", monthlyQuota: 100, actor: null });
    const { record: key } = createMcpKey("k", null, null, null, c.id);

    expect(getConsumerUsageThisMonth(c.id)).toBe(0);
    record(key.id);
    record(key.id);
    record(key.id);
    expect(getConsumerUsageThisMonth(c.id)).toBe(3);
  });

  test("counts are isolated per consumer", () => {
    const a = createConsumer({ name: "team-a", monthlyQuota: 100, actor: null });
    const b = createConsumer({ name: "team-b", monthlyQuota: 100, actor: null });
    const { record: keyA } = createMcpKey("ka", null, null, null, a.id);
    const { record: keyB } = createMcpKey("kb", null, null, null, b.id);

    record(keyA.id);
    record(keyA.id);
    record(keyB.id);

    expect(getConsumerUsageThisMonth(a.id)).toBe(2);
    expect(getConsumerUsageThisMonth(b.id)).toBe(1);
  });

  test("calls from a consumerless or null key never move any counter", () => {
    const c = createConsumer({ name: "team-a", monthlyQuota: 100, actor: null });
    const { record: keyNoConsumer } = createMcpKey("plain", null, null, null);

    record(null);
    record(keyNoConsumer.id);

    expect(getConsumerUsageThisMonth(c.id)).toBe(0);
  });

  test("checkConsumerQuota reflects the counter", () => {
    const c = createConsumer({ name: "team-a", monthlyQuota: 2, actor: null });
    const { record: key } = createMcpKey("k", null, null, null, c.id);

    expect(checkConsumerQuota(c.id).exceeded).toBe(false);
    record(key.id);
    record(key.id);
    const status = checkConsumerQuota(c.id);
    expect(status.used).toBe(2);
    expect(status.exceeded).toBe(true);
  });
});
