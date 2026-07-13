/**
 * Stryker mutation-testing backstop for src/net/ip-validator.ts (the
 * centralised SSRF-defence IP validator: IPv4/IPv6 blocked-range checks,
 * validateBackendUrl's dual-stack DNS resolution, TTL re-pinning, and the
 * pinned-fetch/pinned-lookup transport helpers). 193 mutants, 94.30%
 * baseline (182/193) — the existing ip-validator.test.ts covers IP-literal
 * inputs thoroughly but never exercises a REAL DNS resolution path (every
 * existing test uses an IP literal, which skips DNS entirely) and never
 * touches makePinnedFetch at all.
 *
 * Written directly (no agent round — small survivor count), one file,
 * alongside the existing ip-validator.test.ts (not modified).
 *
 * KEY NEW TECHNIQUE for this file: `Bun.dns.lookup` is a real global that
 * bun:test's `spyOn` can mock directly (`spyOn(Bun.dns, "lookup")`), letting
 * validateBackendUrl's dual-stack DNS branch be driven deterministically —
 * per-family success/failure — without any real network access or flaky
 * live-DNS dependencies. Restore with `.mockRestore()` in every test.
 *
 * EQUIVALENT / NOT-REACHABLE MUTANTS (documented per task instructions
 * rather than dropped):
 *   - 110:14-110:18 BooleanLiteral (the 6to4 branch's catch-block
 *     "return true" -> "return false"). The try block only does a property
 *     read on `parsed.parts` (guaranteed to be an 8-element array by
 *     ipaddr.js after a successful `IPv6.parse()`) plus pure bitwise
 *     arithmetic on numbers and a template-literal — none of which can
 *     throw for any value `parsed.parts` can actually hold post-parse.
 *     This defensive catch has no reachable trigger through the public
 *     API; left undistinguished.
 *   - 159:21-159:71 LogicalOperator (`hostname.startsWith("[") ||
 *     hostname.includes(":")` -> `&&`). These two conditions are only ever
 *     independently true/false-mismatched for a hostname that either (a)
 *     starts with "[" but contains no ":" anywhere, or (b) contains ":"
 *     but doesn't start with "[". The WHATWG URL parser's own `.hostname`
 *     normalization never produces case (a) (a bracketed hostname is only
 *     ever emitted for a real parsed IPv6 literal, which always contains
 *     at least one ":"), and case (b) (a bare, unbracketed IPv6 literal
 *     like "::1") doesn't change the OUTCOME either way: `rawIp` becomes
 *     `hostname` unchanged whether the bracket-stripping regex runs on a
 *     string with no brackets to strip (real, OR-true) or is skipped
 *     entirely (mutant, AND-false for this case) — both paths produce the
 *     identical final `rawIp` value. No URL-parsed hostname can distinguish
 *     `||` from `&&` here.
 *   - 255:40-255:48 StringLiteral (makePinnedFetch's `typeof input ===
 *     "string" ? input : input.toString()` -> `typeof input === ""`, which
 *     is always false, always taking the `.toString()` branch). For a
 *     STRING input, `.toString()` on a string primitive is a documented
 *     no-op (always returns the exact same string), so real-code's `input`
 *     and the mutant's forced `input.toString()` are the same value. For a
 *     URL OBJECT input, `typeof input === "string"` is ALREADY false in
 *     the real code too (`typeof` on an object is `"object"`), so real
 *     code takes the exact same `.toString()` branch the mutant forces
 *     unconditionally. There is no input value — string or URL object —
 *     for which the two branches diverge.
 */
import { describe, test, expect, spyOn } from "bun:test";
import {
  isRawIpLiteral,
  validateBackendUrl,
  makePinnedFetch,
  makePinnedLookup,
  refreshPinIfStale,
  IP_PIN_TTL_MS,
  type PinnedIp,
} from "../../net/ip-validator.js";

type VbuResult = Awaited<ReturnType<typeof validateBackendUrl>>;
/** Asserts the invalid arm and narrows `result` so subsequent `.reason` reads type-check. */
function assertInvalid(r: VbuResult): asserts r is { valid: false; reason: string } {
  expect(r.valid).toBe(false);
}
/** Asserts the valid arm and narrows `result` so subsequent `.resolvedIp` reads type-check. */
function assertValid(r: VbuResult): asserts r is { valid: true; resolvedIp: string } {
  expect(r.valid).toBe(true);
}

type LookupRecord = { address: string; family: number };
type LookupOptions = Parameters<typeof Bun.dns.lookup>[1];

/** Mocks Bun.dns.lookup for exactly one call pair (family 4 + family 6), restoring afterward. */
function mockDns(byFamily: {
  v4?: () => Promise<LookupRecord[]>;
  v6?: () => Promise<LookupRecord[]>;
}): ReturnType<typeof spyOn> {
  return spyOn(Bun.dns, "lookup").mockImplementation((async (_hostname: string, options?: LookupOptions) => {
    const family = options?.family;
    if (family === 4) return byFamily.v4 ? byFamily.v4() : Promise.resolve([]);
    if (family === 6) return byFamily.v6 ? byFamily.v6() : Promise.resolve([]);
    return Promise.resolve([]);
  }) as typeof Bun.dns.lookup);
}

// ===========================================================================
// isBlockedIpv6's 6to4 branch — 102:7-102:23 ConditionalExpression
// [Survived] "true" (range === "6to4" forced always-true).
// ===========================================================================

describe("6to4 extraction only applies to genuinely-6to4 addresses", () => {
  test("a public, non-6to4 IPv6 address whose bit pattern would DECODE to a private IPv4 is still allowed", async () => {
    // 2001:0a00:0001::1 is an ordinary global-unicast IPv6 (range "unicast"),
    // NOT a 6to4 address (those are 2002::/16) — real code must never reach
    // the 6to4 extraction branch for it. Its parts[1]/parts[2] happen to be
    // 0x0a00/0x0001, which the 6to4 extractor would decode as "10.0.0.1" (a
    // blocked RFC-1918 address) if it were wrongly applied.
    const result = await validateBackendUrl("http://[2001:a00:1::1]/", false, []);
    assertValid(result);
  });
});

// ===========================================================================
// validateBackendUrl — URL parsing + protocol gate (L141-150).
// ===========================================================================

describe("validateBackendUrl — malformed URL and protocol rejection", () => {
  // 144:11-146:4 BlockStatement [Survived] (the "catch { return {valid:
  // false, reason: 'Invalid URL'} }" body emptied).
  test("a genuinely unparseable URL is rejected with the exact reason", async () => {
    const result = await validateBackendUrl("not a url at all", false, []);
    expect(result).toEqual({ valid: false, reason: "Invalid URL" });
  });

  // 149:21-149:26 BooleanLiteral [Survived] ("valid: false" -> "valid:
  // true" on the protocol-rejection return object).
  test("a non-http(s) protocol is rejected with valid: false, not silently accepted", async () => {
    const result = await validateBackendUrl("ftp://example.com/", false, []);
    assertInvalid(result);
    expect(result.reason).toBe("Protocol not allowed: ftp:");
  });
});

// ===========================================================================
// validateBackendUrl — bracketed IPv6 literal, full path (L152-168).
// 163:48-163:58 Regex [Survived] (the "^\[|\]$" bracket-strip pattern).
// ===========================================================================

describe("validateBackendUrl — bracketed IPv6 literal end to end", () => {
  test("a bracketed public IPv6 URL resolves with the brackets stripped from resolvedIp", async () => {
    const result = await validateBackendUrl("http://[2606:4700:4700::1111]/", false, []);
    assertValid(result);
    expect(result.resolvedIp).toBe("2606:4700:4700::1111");
  });
});

// ===========================================================================
// isRawIpLiteral — 133:74-133:77 StringLiteral [Survived] (":" -> "").
// ===========================================================================

describe("isRawIpLiteral", () => {
  test("a normal DNS hostname is NOT considered an IP literal", () => {
    expect(isRawIpLiteral("example.com")).toBe(false);
    expect(isRawIpLiteral("api.internal.example.org")).toBe(false);
  });

  test("a dotted-quad IPv4 IS considered an IP literal", () => {
    expect(isRawIpLiteral("93.184.216.34")).toBe(true);
  });

  test("a bracketed IPv6 IS considered an IP literal", () => {
    expect(isRawIpLiteral("[::1]")).toBe(true);
  });
});

// ===========================================================================
// validateBackendUrl — the IP-literal fast path really skips DNS entirely.
// 161:7-161:31 ConditionalExpression [Survived] "false".
// ===========================================================================

describe("validateBackendUrl — IP-literal fast path", () => {
  test("an IP-literal hostname never calls Bun.dns.lookup at all", async () => {
    const dnsSpy = spyOn(Bun.dns, "lookup");
    try {
      const result = await validateBackendUrl("http://93.184.216.34/", false, []);
      assertValid(result);
      expect(result.resolvedIp).toBe("93.184.216.34");
      expect(dnsSpy).not.toHaveBeenCalled();
    } finally {
      dnsSpy.mockRestore();
    }
  });
});

// ===========================================================================
// validateBackendUrl — dual-stack DNS resolution (L170-194).
// ===========================================================================

describe("validateBackendUrl — DNS resolution", () => {
  // 177:95-177:97 ArrayDeclaration [Survived] (the v4Records "[]" fallback
  // on a rejected/failed v4 lookup, poisoned to a non-empty placeholder
  // array containing a bare string instead of a {address} record object).
  // A hostname with NO A record but a real AAAA record must still resolve
  // successfully via IPv6 — under the mutant, the poisoned v4Records
  // entry flows into the shared allRecords loop and crashes on
  // `"...".address` being undefined when isPrivateIp is called on it.
  test("a v4-only-failed, v6-succeeding lookup falls through cleanly to the real IPv6 result", async () => {
    const dnsSpy = mockDns({
      v4: () => Promise.reject(new Error("no A record")),
      v6: () => Promise.resolve([{ address: "2606:4700:4700::1111", family: 6 }]),
    });
    try {
      const result = await validateBackendUrl("http://example.test/", false, []);
      assertValid(result);
      expect(result.resolvedIp).toBe("2606:4700:4700::1111");
    } finally {
      dnsSpy.mockRestore();
    }
  });

  // Mirror case: v6 fails, v4 succeeds — exercises the same fallback
  // array on the OTHER (v6Records) declaration line, and confirms IPv4 is
  // still preferred when both eventually resolve in other scenarios below.
  test("a v6-only-failed, v4-succeeding lookup falls through cleanly to the real IPv4 result", async () => {
    const dnsSpy = mockDns({
      v4: () => Promise.resolve([{ address: "93.184.216.34", family: 4 }]),
      v6: () => Promise.reject(new Error("no AAAA record")),
    });
    try {
      const result = await validateBackendUrl("http://example.test/", false, []);
      assertValid(result);
      expect(result.resolvedIp).toBe("93.184.216.34");
    } finally {
      dnsSpy.mockRestore();
    }
  });

  // 182:7-182:30 ConditionalExpression [Survived] both "true" and "false"
  // ("if (allRecords.length === 0) return {valid:false, reason:...}").
  test("both v4 and v6 failing entirely is reported as a real DNS-resolution failure", async () => {
    const dnsSpy = mockDns({
      v4: () => Promise.reject(new Error("NXDOMAIN")),
      v6: () => Promise.reject(new Error("NXDOMAIN")),
    });
    try {
      const result = await validateBackendUrl("http://ghost.example.test/", false, []);
      assertInvalid(result);
      expect(result.reason).toBe("DNS resolution failed for: ghost.example.test");
    } finally {
      dnsSpy.mockRestore();
    }
  });

  test("a successful resolution (records DO exist) is never wrongly reported as a DNS failure", async () => {
    const dnsSpy = mockDns({
      v4: () => Promise.resolve([{ address: "93.184.216.34", family: 4 }]),
      v6: () => Promise.resolve([]),
    });
    try {
      const result = await validateBackendUrl("http://example.test/", false, []);
      assertValid(result);
      expect(result).not.toHaveProperty("reason");
    } finally {
      dnsSpy.mockRestore();
    }
  });

  // 187:9-187:56 LogicalOperator [Survived] ("!allowPrivateIps &&
  // isPrivateIp(...)" -> "||"). With allowPrivateIps explicitly TRUE, a
  // resolved private-range IP must still be ACCEPTED (the "||" mutant
  // would wrongly reject it regardless of the allowPrivateIps flag, since
  // isPrivateIp(...) alone would already make the whole condition true).
  test("allowPrivateIps=true permits a resolved private-range IP through", async () => {
    const dnsSpy = mockDns({
      v4: () => Promise.resolve([{ address: "10.0.0.5", family: 4 }]),
      v6: () => Promise.resolve([]),
    });
    try {
      const result = await validateBackendUrl("http://internal.example.test/", true, []);
      assertValid(result);
      expect(result.resolvedIp).toBe("10.0.0.5");
    } finally {
      dnsSpy.mockRestore();
    }
  });

  test("allowPrivateIps=false still rejects a resolved private-range IP", async () => {
    const dnsSpy = mockDns({
      v4: () => Promise.resolve([{ address: "10.0.0.5", family: 4 }]),
      v6: () => Promise.resolve([]),
    });
    try {
      const result = await validateBackendUrl("http://internal.example.test/", false, []);
      assertInvalid(result);
      expect(result.reason).toBe("Resolved IP is in a blocked private range: 10.0.0.5");
    } finally {
      dnsSpy.mockRestore();
    }
  });

  // 193:20-193:40 ConditionalExpression [Survived] "false" ("v4Records.length
  // > 0 ? v4Records[0].address : v6Records[0].address" forced to always take
  // the v6 branch). When BOTH v4 and v6 records exist, IPv4 must be
  // preferred for the pinned IP (matches proxy.ts's existing expectations).
  test("when both v4 and v6 records exist, the pinned IP prefers IPv4", async () => {
    const dnsSpy = mockDns({
      v4: () => Promise.resolve([{ address: "93.184.216.34", family: 4 }]),
      v6: () => Promise.resolve([{ address: "2606:4700:4700::1111", family: 6 }]),
    });
    try {
      const result = await validateBackendUrl("http://example.test/", false, []);
      assertValid(result);
      expect(result.resolvedIp).toBe("93.184.216.34");
    } finally {
      dnsSpy.mockRestore();
    }
  });
});

// ===========================================================================
// makePinnedFetch — 254:33-263:4 BlockStatement [Survived] (the whole
// function body emptied). Completely untested by the existing sibling
// file; this is the fetch-based pinning helper used by mcp-upstream.ts's
// SDK transports.
// ===========================================================================

describe("makePinnedFetch", () => {
  test("rewrites the hostname to the pinned IP while preserving the original Host header", async () => {
    const originalFetch = globalThis.fetch;
    let capturedUrl: string | undefined;
    let capturedHost: string | undefined;
    let capturedRedirect: string | undefined;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl = typeof input === "string" ? input : input.toString();
      capturedHost = new Headers(init?.headers).get("Host") ?? undefined;
      capturedRedirect = init?.redirect;
      return new Response("ok");
    }) as typeof fetch;

    try {
      const pinnedFetch = makePinnedFetch("example.com", "93.184.216.34");
      const res = await pinnedFetch("http://example.com/some/path?x=1");
      expect(await res.text()).toBe("ok");
      expect(capturedUrl).toBe("http://93.184.216.34/some/path?x=1");
      expect(capturedHost).toBe("example.com");
      expect(capturedRedirect).toBe("error");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("does NOT rewrite the hostname when it doesn't match the original (no accidental cross-host pinning)", async () => {
    const originalFetch = globalThis.fetch;
    let capturedUrl: string | undefined;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      capturedUrl = typeof input === "string" ? input : input.toString();
      return new Response("ok");
    }) as typeof fetch;

    try {
      const pinnedFetch = makePinnedFetch("example.com", "93.184.216.34");
      await pinnedFetch("http://some-other-host.test/thing");
      expect(capturedUrl).toBe("http://some-other-host.test/thing");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ===========================================================================
// makePinnedLookup — 281:63-283:2 BlockStatement [Survived] (the whole
// function body emptied). Completely untested by the existing sibling
// file; this is the dns.lookup-shaped pinning helper used by ws-proxy.ts's
// raw WebSocket dial.
// ===========================================================================

describe("makePinnedLookup", () => {
  test("always resolves to the pinned IP, regardless of the hostname it's asked to look up", () => {
    const lookup = makePinnedLookup("93.184.216.34");
    const calls: Array<[Error | null, string, number]> = [];
    lookup("totally-different-hostname.test", {}, (err, address, family) => {
      calls.push([err, address, family]);
    });
    expect(calls).toEqual([[null, "93.184.216.34", 4]]);
  });
});

// ===========================================================================
// refreshPinIfStale — 229:83-229:108 LogicalOperator [Survived]
// ("result.reason ?? hostname" -> "result.reason && hostname"). The
// existing sibling test's regex assertion (/private IP|blocked/i) matches
// the message's STATIC prefix text ("...resolves to private IP or failed
// DNS: ...") regardless of what the interpolated suffix is, so it can't
// distinguish "??" from "&&" here. Using a hostname that is textually
// DIFFERENT from the resolved private IP makes the two mutually exclusive:
// real code's suffix is the actual reason (mentioning the blocked IP);
// the mutant's suffix would be the hostname itself instead.
// ===========================================================================

describe("refreshPinIfStale — thrown message uses the real reason, not the hostname", () => {
  test("the thrown error's suffix is validateBackendUrl's actual reason text, not a repeat of the hostname", async () => {
    const dnsSpy = mockDns({
      v4: () => Promise.resolve([{ address: "10.0.0.99", family: 4 }]),
      v6: () => Promise.resolve([]),
    });
    try {
      const now = Date.now();
      const current: PinnedIp = { ip: "1.2.3.4", resolvedAt: now - (IP_PIN_TTL_MS + 1) };
      await expect(refreshPinIfStale("internal-service.example.test", current, now)).rejects.toThrow(
        /Resolved IP is in a blocked private range: 10\.0\.0\.99/,
      );
    } finally {
      dnsSpy.mockRestore();
    }
  });
});
