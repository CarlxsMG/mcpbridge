/**
 * Regression for Finding #8 (P1): refreshPinIfStale used to hardcode
 * `validateBackendUrl(..., false, [])`, so a hostname-registered PRIVATE backend
 * admitted under ALLOW_PRIVATE_IPS=true was permanently rejected the first time
 * its pin went stale (IP_PIN_TTL_MS after registration) — the backend "died"
 * ~5 minutes after registration until the next restart. The TTL re-pin must now
 * honour the same allow-private / allowed-host policy that admitted it, threaded
 * from config by default and overridable for tests.
 */
import { describe, test, expect, spyOn } from "bun:test";
import { refreshPinIfStale, IP_PIN_TTL_MS } from "../../net/ip-validator.js";
import type { PinnedIp } from "../../net/ip-validator.js";

type LookupRecord = { address: string; family: number };
type LookupOptions = Parameters<typeof Bun.dns.lookup>[1];

/** Mocks Bun.dns.lookup so `hostname` resolves to a single private IPv4 (10.1.2.3). */
function mockPrivateDns(): ReturnType<typeof spyOn> {
  return spyOn(Bun.dns, "lookup").mockImplementation((async (_hostname: string, options?: LookupOptions) => {
    const family = options?.family;
    if (family === 4) return Promise.resolve([{ address: "10.1.2.3", family: 4 } satisfies LookupRecord]);
    return Promise.resolve([]);
  }) as typeof Bun.dns.lookup);
}

const PAST_TTL = IP_PIN_TTL_MS + 1;

describe("refreshPinIfStale honours allowPrivateIps (Finding #8)", () => {
  test("past TTL, allowPrivateIps=true — a private hostname re-pins successfully (the dispatch posture under ALLOW_PRIVATE_IPS=true)", async () => {
    // dispatch-rest.ts threads config.allowPrivateIps/allowedHosts into this call;
    // under ALLOW_PRIVATE_IPS=true that is `true`, and the re-pin of a private
    // hostname MUST succeed rather than being permanently rejected post-TTL.
    const dns = mockPrivateDns();
    try {
      const current: PinnedIp = { ip: "10.1.2.3", resolvedAt: 0 };
      const result = await refreshPinIfStale("internal.corp", current, PAST_TTL, true, []);
      expect(result.ip).toBe("10.1.2.3");
      expect(result.resolvedAt).toBe(PAST_TTL);
    } finally {
      dns.mockRestore();
    }
  });

  test("past TTL, default (no policy args) stays strict — a private hostname is rejected", async () => {
    // The wrapper never widens a caller's intent: with no explicit policy the
    // default is allowPrivateIps=false, so a now-private hostname is rejected.
    const dns = mockPrivateDns();
    try {
      const current: PinnedIp = { ip: "10.1.2.3", resolvedAt: 0 };
      await expect(refreshPinIfStale("internal.corp", current, PAST_TTL)).rejects.toThrow(/private IP|blocked/i);
    } finally {
      dns.mockRestore();
    }
  });

  test("past TTL, allowPrivateIps=false (explicit) still rejects a now-private hostname (SSRF unchanged)", async () => {
    const dns = mockPrivateDns();
    try {
      const current: PinnedIp = { ip: "10.1.2.3", resolvedAt: 0 };
      await expect(refreshPinIfStale("internal.corp", current, PAST_TTL, false, [])).rejects.toThrow(
        /private IP|blocked/i,
      );
    } finally {
      dns.mockRestore();
    }
  });

  test("within TTL returns the current pin unchanged and never resolves DNS", async () => {
    const dns = spyOn(Bun.dns, "lookup");
    try {
      const current: PinnedIp = { ip: "10.1.2.3", resolvedAt: 1000 };
      const result = await refreshPinIfStale("internal.corp", current, 1000 + IP_PIN_TTL_MS - 1, true, []);
      expect(result).toBe(current);
      expect(dns).not.toHaveBeenCalled();
    } finally {
      dns.mockRestore();
    }
  });
});
