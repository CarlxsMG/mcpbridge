import { describe, test, expect, mock, spyOn } from "bun:test";
import { validateBackendUrl, refreshPinIfStale, IP_PIN_TTL_MS } from "../security/ip-validator.js";
import type { PinnedIp } from "../security/ip-validator.js";

// ---------------------------------------------------------------------------
// SSRF — IPv4-mapped IPv6 and other blocked ranges
// These tests would fail if the IPv4-mapped extraction logic were removed.
// ---------------------------------------------------------------------------

describe("validateBackendUrl — IPv4-mapped IPv6 SSRF", () => {
  test("rejects ::ffff:127.0.0.1 (loopback dotted-decimal form)", async () => {
    const result = await validateBackendUrl("http://[::ffff:127.0.0.1]/", false, []);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/blocked private range/i);
  });

  test("rejects ::ffff:7f00:0001 (loopback hex-word form)", async () => {
    const result = await validateBackendUrl("http://[::ffff:7f00:0001]/", false, []);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/blocked private range/i);
  });

  test("rejects ::ffff:10.0.0.1 (RFC-1918 class-A mapped)", async () => {
    const result = await validateBackendUrl("http://[::ffff:10.0.0.1]/", false, []);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/blocked private range/i);
  });

  test("rejects 100.64.0.5 (CGNAT RFC-6598)", async () => {
    const result = await validateBackendUrl("http://100.64.0.5/", false, []);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/blocked private range/i);
  });

  test("rejects [::] (unspecified IPv6 address)", async () => {
    const result = await validateBackendUrl("http://[::]/", false, []);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/blocked private range/i);
  });

  test("rejects 192.0.2.1 (TEST-NET-1 RFC-5737)", async () => {
    const result = await validateBackendUrl("http://192.0.2.1/", false, []);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/blocked private range/i);
  });

  test("accepts 93.184.216.34 (example.com — public IP)", async () => {
    const result = await validateBackendUrl("http://93.184.216.34/", false, []);
    expect(result.valid).toBe(true);
    expect(result.resolvedIp).toBe("93.184.216.34");
  });
});

// ---------------------------------------------------------------------------
// IPv6 SSRF — extended coverage (6to4, NAT64, ULA, link-local, documentation)
// ---------------------------------------------------------------------------

describe("validateBackendUrl — IPv6 SSRF extended coverage", () => {
  test("rejects 2002:0a00:0001:: (6to4 encoding RFC-1918 10.0.0.1)", async () => {
    // 2002::/16 + 0a00:0001 = 10.0.0.1 embedded
    const result = await validateBackendUrl("http://[2002:0a00:0001::]/", false, []);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/blocked private range/i);
  });

  test("rejects 64:ff9b::7f00:1 (NAT64 encoding loopback 127.0.0.1)", async () => {
    // 64:ff9b::/96 NAT64 — last 32 bits 7f00:0001 = 127.0.0.1
    const result = await validateBackendUrl("http://[64:ff9b::7f00:1]/", false, []);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/blocked private range/i);
  });

  test("rejects ::ffff:10.0.0.1 (IPv4-mapped private RFC-1918)", async () => {
    const result = await validateBackendUrl("http://[::ffff:10.0.0.1]/", false, []);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/blocked private range/i);
  });

  test("rejects fc00::1 (ULA — unique local fc00::/7)", async () => {
    const result = await validateBackendUrl("http://[fc00::1]/", false, []);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/blocked private range/i);
  });

  test("rejects fe80::1 (link-local fe80::/10)", async () => {
    const result = await validateBackendUrl("http://[fe80::1]/", false, []);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/blocked private range/i);
  });

  test("rejects 2001:db8::1 (documentation 2001:db8::/32)", async () => {
    const result = await validateBackendUrl("http://[2001:db8::1]/", false, []);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/blocked private range/i);
  });

  test("accepts 2606:4700:4700::1111 (Cloudflare public DNS — public IPv6)", async () => {
    const result = await validateBackendUrl("http://[2606:4700:4700::1111]/", false, []);
    expect(result.valid).toBe(true);
    expect(result.resolvedIp).toBe("2606:4700:4700::1111");
  });
});

// ---------------------------------------------------------------------------
// TTL re-resolution — refreshPinIfStale
// ---------------------------------------------------------------------------

describe("refreshPinIfStale — within TTL", () => {
  test("returns the same pin object when called within TTL window", async () => {
    const now = Date.now();
    const current: PinnedIp = { ip: "1.2.3.4", resolvedAt: now - 1000 }; // 1 s ago
    // now - resolvedAt = 1000 < IP_PIN_TTL_MS (300_000) → should return immediately
    const result = await refreshPinIfStale("example.com", current, now);
    expect(result).toBe(current); // strict identity — no re-resolve happened
  });
});

describe("refreshPinIfStale — past TTL, public IP", () => {
  test("returns a refreshed pin when the TTL has elapsed and IP is public", async () => {
    // Use a raw IP URL so no real DNS lookup fires (validateBackendUrl fast-paths raw IPs).
    const now = Date.now();
    const staleAge = IP_PIN_TTL_MS + 1;
    const current: PinnedIp = { ip: "93.184.216.34", resolvedAt: now - staleAge };

    // Call with a raw IPv4 hostname so validateBackendUrl returns immediately without DNS.
    const result = await refreshPinIfStale("93.184.216.34", current, now);

    expect(result).not.toBe(current);               // new object
    expect(result.ip).toBe("93.184.216.34");         // same IP (it's a raw literal)
    expect(result.resolvedAt).toBe(now);             // timestamp updated
  });
});

describe("refreshPinIfStale — past TTL, private IP → throws", () => {
  test("throws when fresh resolution lands on a blocked private IP", async () => {
    const now = Date.now();
    const staleAge = IP_PIN_TTL_MS + 1;
    // Hostname is a raw private IP — validateBackendUrl will reject it.
    const current: PinnedIp = { ip: "10.0.0.1", resolvedAt: now - staleAge };

    await expect(
      refreshPinIfStale("10.0.0.1", current, now)
    ).rejects.toThrow(/private IP|blocked/i);
  });
});
