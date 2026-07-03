import { describe, test, expect, afterEach } from "bun:test";
import { parseCorsOrigins } from "../config.js";

// ---------------------------------------------------------------------------
// Unit tests for config.ts's parsing helpers.
//
// Only `parseCorsOrigins` is exported from config.ts. `normaliseOrigin` and
// `parseTrustProxy` are private module-level functions:
//
//   - `normaliseOrigin(raw)` is called once per entry, from inside the
//     exported `parseCorsOrigins`, so its full behavior (scheme validation,
//     host lowercasing, port canonicalisation, path/query/fragment
//     rejection) is exercised — and asserted below — through that public
//     entry point rather than by duplicating its logic.
//
//   - `parseTrustProxy()` takes no arguments and reads `process.env.
//     TRUST_PROXY` directly, computing `config.trustProxy` exactly once at
//     module-load time. To exercise it directly (rather than duplicating its
//     ~10 lines of logic inline, which would test a copy and not the real
//     code), each test below sets `process.env.TRUST_PROXY` and then
//     dynamically re-imports config.ts with a unique cache-busting query
//     string so the module body (including the `parseTrustProxy()` call)
//     re-runs against the new env value. This mirrors how config.ts is
//     actually invoked (env-var-driven, at process startup) without
//     modifying the source file to export the private helper.
// ---------------------------------------------------------------------------

// ─── parseCorsOrigins (and, transitively, normaliseOrigin) ──────────────────

describe("parseCorsOrigins — empty / absent input", () => {
  test("undefined raw value returns an empty array", () => {
    expect(parseCorsOrigins(undefined, false)).toEqual([]);
  });

  test("empty string returns an empty array", () => {
    expect(parseCorsOrigins("", false)).toEqual([]);
  });

  test("whitespace-only string returns an empty array", () => {
    expect(parseCorsOrigins("   ", false)).toEqual([]);
  });
});

describe("parseCorsOrigins — single / multiple origins", () => {
  test("a single valid https origin is normalised and returned", () => {
    expect(parseCorsOrigins("https://example.com", false)).toEqual(["https://example.com"]);
  });

  test("a comma-separated list of origins is parsed in order", () => {
    expect(parseCorsOrigins("https://a.com,https://b.com,http://c.com", false)).toEqual([
      "https://a.com",
      "https://b.com",
      "http://c.com",
    ]);
  });

  test("whitespace around entries and commas is trimmed", () => {
    expect(parseCorsOrigins("  https://a.com , https://b.com  ", false)).toEqual(["https://a.com", "https://b.com"]);
  });

  test("empty entries produced by stray commas are dropped", () => {
    expect(parseCorsOrigins("https://a.com,,https://b.com,", false)).toEqual(["https://a.com", "https://b.com"]);
  });
});

describe("parseCorsOrigins — normalisation (via normaliseOrigin)", () => {
  test("host is lowercased", () => {
    expect(parseCorsOrigins("https://EXAMPLE.COM", false)).toEqual(["https://example.com"]);
  });

  test("a default-scheme port is dropped, a non-default port is kept", () => {
    expect(parseCorsOrigins("https://example.com:443", false)).toEqual(["https://example.com"]);
    expect(parseCorsOrigins("http://example.com:80", false)).toEqual(["http://example.com"]);
    expect(parseCorsOrigins("https://example.com:8443", false)).toEqual(["https://example.com:8443"]);
  });

  test("a trailing slash (root path) is normalised away, no trailing slash in output", () => {
    expect(parseCorsOrigins("https://example.com/", false)).toEqual(["https://example.com"]);
  });
});

describe("parseCorsOrigins — invalid entries throw", () => {
  test("a non-URL string throws", () => {
    expect(() => parseCorsOrigins("not a url", false)).toThrow(/Invalid CORS origin/);
  });

  test("an unsupported scheme (ftp) throws", () => {
    expect(() => parseCorsOrigins("ftp://example.com", false)).toThrow(/Invalid CORS origin/);
  });

  test("a URL with a non-root path throws", () => {
    expect(() => parseCorsOrigins("https://example.com/path", false)).toThrow(/Invalid CORS origin/);
  });

  test("a URL with a query string throws", () => {
    expect(() => parseCorsOrigins("https://example.com/?x=1", false)).toThrow(/Invalid CORS origin/);
  });

  test("a URL with a fragment throws", () => {
    expect(() => parseCorsOrigins("https://example.com/#frag", false)).toThrow(/Invalid CORS origin/);
  });

  test("one bad entry among otherwise-valid entries still throws", () => {
    expect(() => parseCorsOrigins("https://good.com,not a url", false)).toThrow(/Invalid CORS origin/);
  });
});

describe("parseCorsOrigins — wildcard gating", () => {
  const originalAllowUnsafe = process.env.ALLOW_UNSAFE_CORS_WILDCARD;

  afterEach(() => {
    if (originalAllowUnsafe === undefined) {
      delete process.env.ALLOW_UNSAFE_CORS_WILDCARD;
    } else {
      process.env.ALLOW_UNSAFE_CORS_WILDCARD = originalAllowUnsafe;
    }
  });

  test("'*' with authDisabled=false and no escape hatch throws", () => {
    delete process.env.ALLOW_UNSAFE_CORS_WILDCARD;
    expect(() => parseCorsOrigins("*", false)).toThrow(/wildcard/i);
  });

  test("'*' with authDisabled=true is allowed without the escape hatch", () => {
    delete process.env.ALLOW_UNSAFE_CORS_WILDCARD;
    expect(parseCorsOrigins("*", true)).toEqual(["*"]);
  });

  test("'*' with authDisabled=false but ALLOW_UNSAFE_CORS_WILDCARD=true is allowed", () => {
    process.env.ALLOW_UNSAFE_CORS_WILDCARD = "true";
    expect(parseCorsOrigins("*", false)).toEqual(["*"]);
  });

  test("'*' mixed with other origins still collapses to wildcard mode", () => {
    process.env.ALLOW_UNSAFE_CORS_WILDCARD = "true";
    expect(parseCorsOrigins("https://a.com,*,https://b.com", false)).toEqual(["*"]);
  });

  test("ALLOW_UNSAFE_CORS_WILDCARD set to a non-'true' string does NOT enable the escape hatch", () => {
    process.env.ALLOW_UNSAFE_CORS_WILDCARD = "1";
    expect(() => parseCorsOrigins("*", false)).toThrow(/wildcard/i);
  });
});

// ─── parseTrustProxy (private — exercised via a fresh config.ts import) ────

/**
 * Re-imports config.ts as a brand-new module instance with the given
 * TRUST_PROXY env value, so its module-level `parseTrustProxy()` call
 * re-runs. The cache-busting query string forces Bun's ESM loader to treat
 * each call as a distinct module (verified: config.ts has no other
 * env-dependent side effects that would make a fresh import unsafe — it
 * only builds a plain config object, no timers/IO at import time).
 */
let importCounter = 0;
async function importFreshTrustProxy(value: string | undefined): Promise<boolean | number | string> {
  const prevTrustProxy = process.env.TRUST_PROXY;
  const prevCorsOrigins = process.env.CORS_ORIGINS;
  // Keep CORS_ORIGINS unset so the fresh module's top-level parseCorsOrigins()
  // call can't throw and derail an unrelated trust-proxy test.
  delete process.env.CORS_ORIGINS;
  if (value === undefined) {
    delete process.env.TRUST_PROXY;
  } else {
    process.env.TRUST_PROXY = value;
  }

  importCounter++;
  const mod = (await import(`../config.js?trustproxytest=${importCounter}`)) as {
    config: { trustProxy: boolean | number | string };
  };

  if (prevTrustProxy === undefined) delete process.env.TRUST_PROXY;
  else process.env.TRUST_PROXY = prevTrustProxy;
  if (prevCorsOrigins === undefined) delete process.env.CORS_ORIGINS;
  else process.env.CORS_ORIGINS = prevCorsOrigins;

  return mod.config.trustProxy;
}

describe("parseTrustProxy — absent / boolean", () => {
  test("absent TRUST_PROXY -> false", async () => {
    expect(await importFreshTrustProxy(undefined)).toBe(false);
  });

  test("TRUST_PROXY='true' -> boolean true", async () => {
    expect(await importFreshTrustProxy("true")).toBe(true);
  });

  test("TRUST_PROXY='false' -> the literal string is NOT the boolean 'true' branch, falls through to CSV passthrough", async () => {
    // Only the exact string "true" maps to boolean true; anything else that
    // isn't a positive number is passed through as a raw string (Express
    // accepts CSV of IPs/CIDRs/presets) — this documents that "false" is NOT
    // specially handled and is NOT equivalent to the absent-env default.
    expect(await importFreshTrustProxy("false")).toBe("false");
  });
});

describe("parseTrustProxy — numeric hop count", () => {
  test("TRUST_PROXY='1' -> number 1", async () => {
    expect(await importFreshTrustProxy("1")).toBe(1);
  });

  test("TRUST_PROXY='3' -> number 3", async () => {
    expect(await importFreshTrustProxy("3")).toBe(3);
  });

  test("TRUST_PROXY='0' -> not a positive number, passed through as the raw string '0'", async () => {
    // Number("0") = 0, and the guard requires `asNumber > 0`, so "0" falls
    // through to the CSV/string passthrough branch rather than becoming
    // number 0 or boolean false.
    expect(await importFreshTrustProxy("0")).toBe("0");
  });

  test("TRUST_PROXY='-1' -> negative, passed through as the raw string", async () => {
    expect(await importFreshTrustProxy("-1")).toBe("-1");
  });
});

describe("parseTrustProxy — CSV / named presets / hostnames", () => {
  test("a single IP is passed through as-is", async () => {
    expect(await importFreshTrustProxy("127.0.0.1")).toBe("127.0.0.1");
  });

  test("a comma-separated CIDR list is passed through as-is", async () => {
    expect(await importFreshTrustProxy("10.0.0.0/8,192.168.0.0/16")).toBe("10.0.0.0/8,192.168.0.0/16");
  });

  test("a named Express preset (e.g. 'loopback') is passed through as-is", async () => {
    expect(await importFreshTrustProxy("loopback")).toBe("loopback");
  });

  test("a non-numeric, non-'true' arbitrary string is passed through as-is", async () => {
    expect(await importFreshTrustProxy("uniquelocal")).toBe("uniquelocal");
  });
});

// ─── parseSecretsProvider (private — exercised via a fresh config.ts import) ─

/**
 * Re-imports config.ts as a brand-new module instance with the given
 * SECRETS_PROVIDER env value, so its module-level `parseSecretsProvider()`
 * call re-runs. Unlike `parseTrustProxy`, this parser can throw at
 * module-load time (an invalid value), so the import itself is wrapped in a
 * try/finally to guarantee env vars are restored either way.
 */
let importCounterSecrets = 0;
async function importFreshSecretsProvider(value: string | undefined): Promise<"local" | "vault"> {
  const prevSecretsProvider = process.env.SECRETS_PROVIDER;
  const prevTrustProxy = process.env.TRUST_PROXY;
  const prevCorsOrigins = process.env.CORS_ORIGINS;
  delete process.env.TRUST_PROXY;
  delete process.env.CORS_ORIGINS;
  if (value === undefined) delete process.env.SECRETS_PROVIDER;
  else process.env.SECRETS_PROVIDER = value;

  importCounterSecrets++;
  try {
    const mod = (await import(`../config.js?secretsprovidertest=${importCounterSecrets}`)) as {
      config: { secretsProvider: "local" | "vault" };
    };
    return mod.config.secretsProvider;
  } finally {
    if (prevSecretsProvider === undefined) delete process.env.SECRETS_PROVIDER;
    else process.env.SECRETS_PROVIDER = prevSecretsProvider;
    if (prevTrustProxy === undefined) delete process.env.TRUST_PROXY;
    else process.env.TRUST_PROXY = prevTrustProxy;
    if (prevCorsOrigins === undefined) delete process.env.CORS_ORIGINS;
    else process.env.CORS_ORIGINS = prevCorsOrigins;
  }
}

describe("parseSecretsProvider", () => {
  test("absent SECRETS_PROVIDER -> 'local'", async () => {
    expect(await importFreshSecretsProvider(undefined)).toBe("local");
  });

  test("SECRETS_PROVIDER='local' -> 'local'", async () => {
    expect(await importFreshSecretsProvider("local")).toBe("local");
  });

  test("SECRETS_PROVIDER='vault' -> 'vault'", async () => {
    expect(await importFreshSecretsProvider("vault")).toBe("vault");
  });

  test("an invalid value throws at config-load time rather than silently defaulting to 'local'", async () => {
    await expect(importFreshSecretsProvider("bogus")).rejects.toThrow(/Invalid SECRETS_PROVIDER/);
  });
});
