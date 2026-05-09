import { describe, test, expect } from "bun:test";
import { validateBackendUrl } from "../security/ip-validator.js";

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
