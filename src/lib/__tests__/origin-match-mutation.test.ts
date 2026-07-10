import { describe, expect, test } from "bun:test";

import { matchesOriginEntry } from "../origin-match.js";

// ---------------------------------------------------------------------------
// Mutation-testing backstop for `src/lib/origin-match.ts` — the shared
// Origin-header-vs-allowlist-entry comparison primitive used by both
// `middleware/cors.ts` and `middleware/origin-validator.ts`. Pure URL-parsing
// logic, no I/O. Zero prior dedicated coverage (each middleware's own test
// only exercises this indirectly).
// ---------------------------------------------------------------------------

describe("matchesOriginEntry — literal '*' entry", () => {
  test("matches unconditionally regardless of origin shape", () => {
    expect(matchesOriginEntry("https://example.com", "*", { supportsPortWildcard: false })).toBe(true);
    expect(matchesOriginEntry("not-a-valid-url", "*", { supportsPortWildcard: true })).toBe(true);
    expect(matchesOriginEntry("", "*", { supportsPortWildcard: false })).toBe(true);
  });

  test("only an EXACT '*' string triggers the wildcard — not a prefix/substring", () => {
    // Guards against `entry === "*"` being mutated to something that still
    // matches a longer string containing '*'.
    expect(matchesOriginEntry("https://example.com", "*x", { supportsPortWildcard: false })).toBe(false);
    expect(matchesOriginEntry("https://example.com", "**", { supportsPortWildcard: false })).toBe(false);
  });
});

describe("matchesOriginEntry — port-wildcard entries (':*' suffix)", () => {
  test("matches when protocol+hostname agree and supportsPortWildcard is true, ignoring port", () => {
    expect(matchesOriginEntry("http://localhost:3000", "http://localhost:*", { supportsPortWildcard: true })).toBe(
      true,
    );
    expect(matchesOriginEntry("http://localhost:9999", "http://localhost:*", { supportsPortWildcard: true })).toBe(
      true,
    );
    // Default-port origin (no explicit port in the Origin header) also matches.
    expect(matchesOriginEntry("http://localhost", "http://localhost:*", { supportsPortWildcard: true })).toBe(true);
  });

  test("does NOT apply the port-wildcard rule when supportsPortWildcard is false (cors.ts's rule set)", () => {
    // Even though the entry ends in ':*', with the flag off it falls through
    // to the exact-match branch below, where entry.slice is never applied —
    // "http://localhost:*" fails to parse as a URL port and/or simply
    // doesn't equal the origin's port, so it must be rejected.
    expect(matchesOriginEntry("http://localhost:3000", "http://localhost:*", { supportsPortWildcard: false })).toBe(
      false,
    );
  });

  test("port-wildcard entry requires supportsPortWildcard AND the ':*' suffix — both clauses independently", () => {
    // supportsPortWildcard true, but entry does NOT end in ':*' -> falls to
    // exact match, and ports differ -> false.
    expect(matchesOriginEntry("http://localhost:3000", "http://localhost:4000", { supportsPortWildcard: true })).toBe(
      false,
    );
  });

  test("rejects when hostname differs even though protocol matches (port-wildcard branch)", () => {
    expect(matchesOriginEntry("http://localhost:3000", "http://other-host:*", { supportsPortWildcard: true })).toBe(
      false,
    );
  });

  test("rejects when protocol differs even though hostname matches (port-wildcard branch)", () => {
    expect(matchesOriginEntry("https://localhost:3000", "http://localhost:*", { supportsPortWildcard: true })).toBe(
      false,
    );
  });

  test("returns false (not throw) when origin fails to parse, port-wildcard branch", () => {
    expect(matchesOriginEntry("not a url", "http://localhost:*", { supportsPortWildcard: true })).toBe(false);
  });

  test("returns false (not throw) when the entry (after stripping ':*') fails to parse", () => {
    // "*" alone is not a full URL when stripped of ':*' semantics here: use a
    // genuinely unparseable prefix.
    expect(matchesOriginEntry("http://localhost:3000", "://bad:*", { supportsPortWildcard: true })).toBe(false);
  });

  test("hostname comparison is case-insensitive on both sides (lowercased before compare)", () => {
    expect(matchesOriginEntry("http://LOCALHOST:3000", "http://localhost:*", { supportsPortWildcard: true })).toBe(
      true,
    );
    expect(matchesOriginEntry("http://localhost:3000", "HTTP://LOCALHOST:*", { supportsPortWildcard: true })).toBe(
      true,
    );
  });
});

describe("matchesOriginEntry — exact-match branch (no port-wildcard)", () => {
  test("matches when protocol, hostname, and port are all identical", () => {
    expect(
      matchesOriginEntry("https://example.com:8443", "https://example.com:8443", { supportsPortWildcard: false }),
    ).toBe(true);
  });

  test("matches when both sides omit an explicit port (both '')", () => {
    expect(matchesOriginEntry("https://example.com", "https://example.com", { supportsPortWildcard: false })).toBe(
      true,
    );
  });

  test("rejects when ports differ", () => {
    expect(
      matchesOriginEntry("https://example.com:8443", "https://example.com:9443", { supportsPortWildcard: false }),
    ).toBe(false);
  });

  test("rejects when one side has an explicit port and the other omits it", () => {
    expect(matchesOriginEntry("https://example.com:8443", "https://example.com", { supportsPortWildcard: false })).toBe(
      false,
    );
    expect(matchesOriginEntry("https://example.com", "https://example.com:8443", { supportsPortWildcard: false })).toBe(
      false,
    );
  });

  test("rejects when hostnames differ (ports and protocol identical)", () => {
    expect(matchesOriginEntry("https://example.com", "https://example.org", { supportsPortWildcard: false })).toBe(
      false,
    );
  });

  test("rejects when protocols differ (hostnames and ports identical)", () => {
    expect(matchesOriginEntry("http://example.com", "https://example.com", { supportsPortWildcard: false })).toBe(
      false,
    );
  });

  test("hostname comparison is case-insensitive", () => {
    expect(matchesOriginEntry("https://EXAMPLE.com", "https://example.COM", { supportsPortWildcard: false })).toBe(
      true,
    );
  });

  test("returns false (not throw) when origin fails to parse", () => {
    expect(matchesOriginEntry("not a url", "https://example.com", { supportsPortWildcard: false })).toBe(false);
  });

  test("returns false (not throw) when entry fails to parse", () => {
    expect(matchesOriginEntry("https://example.com", "not a url", { supportsPortWildcard: false })).toBe(false);
  });

  test("returns false when both origin and entry fail to parse", () => {
    expect(matchesOriginEntry("not a url", "also not a url", { supportsPortWildcard: false })).toBe(false);
  });

  test("an entry ending in ':*' still goes through exact match when supportsPortWildcard is false, and is rejected", () => {
    // Cross-check: with the flag off, "*" suffix semantics never activate,
    // so "http://localhost:*" is parsed as a literal URL (which fails,
    // since ':*' isn't a valid port) and the comparison returns false.
    expect(matchesOriginEntry("http://localhost:3000", "http://localhost:*", { supportsPortWildcard: false })).toBe(
      false,
    );
  });
});

describe("matchesOriginEntry — options.supportsPortWildcard true but entry has no ':*' suffix", () => {
  test("falls through to exact match and can still succeed", () => {
    expect(
      matchesOriginEntry("https://example.com:8443", "https://example.com:8443", { supportsPortWildcard: true }),
    ).toBe(true);
  });

  test("falls through to exact match and can still fail on port mismatch", () => {
    expect(
      matchesOriginEntry("https://example.com:8443", "https://example.com:9443", { supportsPortWildcard: true }),
    ).toBe(false);
  });
});
