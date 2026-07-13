import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { checkStartupGuards } from "../../security/startup-guards.js";
import type { StartupGuardEnv } from "../../security/startup-guards.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function safeEnv(overrides: Partial<StartupGuardEnv> = {}): StartupGuardEnv {
  return {
    authDisabled: false,
    corsOrigins: ["https://example.com"],
    trustProxy: false,
    nodeEnv: "production",
    sessionCookieSecure: true,
    jwtJwksUrl: undefined,
    jwtAudience: undefined,
    ...overrides,
  };
}

// Ensure ALLOW_UNSAFE_* does not leak between tests
let savedAllowUnsafe: string | undefined;
let savedAllowUnsafeCookie: string | undefined;
let savedAllowUnsafeJwt: string | undefined;
beforeEach(() => {
  savedAllowUnsafe = process.env.ALLOW_UNSAFE_AUTH_DISABLED;
  delete process.env.ALLOW_UNSAFE_AUTH_DISABLED;
  savedAllowUnsafeCookie = process.env.ALLOW_UNSAFE_INSECURE_SESSION_COOKIE;
  delete process.env.ALLOW_UNSAFE_INSECURE_SESSION_COOKIE;
  savedAllowUnsafeJwt = process.env.ALLOW_UNSAFE_JWT_NO_AUDIENCE;
  delete process.env.ALLOW_UNSAFE_JWT_NO_AUDIENCE;
});
afterEach(() => {
  if (savedAllowUnsafe === undefined) {
    delete process.env.ALLOW_UNSAFE_AUTH_DISABLED;
  } else {
    process.env.ALLOW_UNSAFE_AUTH_DISABLED = savedAllowUnsafe;
  }
  if (savedAllowUnsafeCookie === undefined) {
    delete process.env.ALLOW_UNSAFE_INSECURE_SESSION_COOKIE;
  } else {
    process.env.ALLOW_UNSAFE_INSECURE_SESSION_COOKIE = savedAllowUnsafeCookie;
  }
  if (savedAllowUnsafeJwt === undefined) {
    delete process.env.ALLOW_UNSAFE_JWT_NO_AUDIENCE;
  } else {
    process.env.ALLOW_UNSAFE_JWT_NO_AUDIENCE = savedAllowUnsafeJwt;
  }
});

// ---------------------------------------------------------------------------
// AUTH_DISABLED guard
// ---------------------------------------------------------------------------

describe("checkStartupGuards — AUTH_DISABLED", () => {
  test("AUTH_DISABLED=true + NODE_ENV=production → fail with AUTH_DISABLED in reason", () => {
    const result = checkStartupGuards(safeEnv({ authDisabled: true, nodeEnv: "production" }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("AUTH_DISABLED");
    }
  });

  test("AUTH_DISABLED=true + NODE_ENV=development → ok (allowed in dev)", () => {
    const result = checkStartupGuards(safeEnv({ authDisabled: true, nodeEnv: "development" }));
    expect(result.ok).toBe(true);
  });

  test("AUTH_DISABLED=false + NODE_ENV=production → ok", () => {
    const result = checkStartupGuards(safeEnv({ authDisabled: false, nodeEnv: "production" }));
    expect(result.ok).toBe(true);
  });

  test("AUTH_DISABLED=true + ALLOW_UNSAFE_AUTH_DISABLED=true + NODE_ENV=production → ok (escape hatch)", () => {
    process.env.ALLOW_UNSAFE_AUTH_DISABLED = "true";
    const result = checkStartupGuards(safeEnv({ authDisabled: true, nodeEnv: "production" }));
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// CORS wildcard guard
// ---------------------------------------------------------------------------

describe("checkStartupGuards — CORS wildcard", () => {
  test("CORS_ORIGINS=['*'] + NODE_ENV=production → fail with CORS or wildcard in reason", () => {
    const result = checkStartupGuards(safeEnv({ corsOrigins: ["*"], nodeEnv: "production" }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason.toLowerCase()).toMatch(/cors|wildcard/);
    }
  });

  test("CORS_ORIGINS=['*'] + NODE_ENV=development → ok (allowed in dev)", () => {
    const result = checkStartupGuards(safeEnv({ corsOrigins: ["*"], nodeEnv: "development" }));
    expect(result.ok).toBe(true);
  });

  test("CORS_ORIGINS=['https://example.com'] + NODE_ENV=production → ok", () => {
    const result = checkStartupGuards(safeEnv({ corsOrigins: ["https://example.com"], nodeEnv: "production" }));
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// TRUST_PROXY boolean guard
// ---------------------------------------------------------------------------

describe("checkStartupGuards — TRUST_PROXY", () => {
  test("TRUST_PROXY=true (boolean) + NODE_ENV=production → fail with TRUST_PROXY in reason", () => {
    const result = checkStartupGuards(safeEnv({ trustProxy: true, nodeEnv: "production" }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("TRUST_PROXY");
    }
  });

  test("TRUST_PROXY=true + NODE_ENV=development → ok (allowed in dev)", () => {
    const result = checkStartupGuards(safeEnv({ trustProxy: true, nodeEnv: "development" }));
    expect(result.ok).toBe(true);
  });

  test("TRUST_PROXY=1 (number) + NODE_ENV=production → ok (numeric hop count is fine)", () => {
    const result = checkStartupGuards(safeEnv({ trustProxy: 1, nodeEnv: "production" }));
    expect(result.ok).toBe(true);
  });

  test("TRUST_PROXY='loopback' (string) + NODE_ENV=production → ok", () => {
    const result = checkStartupGuards(safeEnv({ trustProxy: "loopback", nodeEnv: "production" }));
    expect(result.ok).toBe(true);
  });

  test("TRUST_PROXY=false + NODE_ENV=production → ok", () => {
    const result = checkStartupGuards(safeEnv({ trustProxy: false, nodeEnv: "production" }));
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Insecure session cookie guard
// ---------------------------------------------------------------------------

describe("checkStartupGuards — SESSION_COOKIE_SECURE", () => {
  test("sessionCookieSecure=false + NODE_ENV=production → fail with SESSION_COOKIE in reason", () => {
    const result = checkStartupGuards(safeEnv({ sessionCookieSecure: false, nodeEnv: "production" }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("SESSION_COOKIE");
    }
  });

  test("sessionCookieSecure=false + NODE_ENV=development → ok (allowed in dev)", () => {
    const result = checkStartupGuards(safeEnv({ sessionCookieSecure: false, nodeEnv: "development" }));
    expect(result.ok).toBe(true);
  });

  test("sessionCookieSecure=false + ALLOW_UNSAFE_INSECURE_SESSION_COOKIE=true + NODE_ENV=production → ok (escape hatch)", () => {
    process.env.ALLOW_UNSAFE_INSECURE_SESSION_COOKIE = "true";
    const result = checkStartupGuards(safeEnv({ sessionCookieSecure: false, nodeEnv: "production" }));
    expect(result.ok).toBe(true);
  });

  test("sessionCookieSecure=true + NODE_ENV=production → ok", () => {
    const result = checkStartupGuards(safeEnv({ sessionCookieSecure: true, nodeEnv: "production" }));
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// JWT audience-binding guard
// ---------------------------------------------------------------------------

describe("checkStartupGuards — JWT audience binding", () => {
  const JWKS = "https://idp.example.com/.well-known/jwks.json";

  test("JWT_JWKS_URL set without JWT_AUDIENCE + NODE_ENV=production → fail with JWT_AUDIENCE in reason", () => {
    const result = checkStartupGuards(safeEnv({ jwtJwksUrl: JWKS, jwtAudience: undefined, nodeEnv: "production" }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("JWT_AUDIENCE");
    }
  });

  test("JWT_JWKS_URL set without JWT_AUDIENCE + NODE_ENV=development → ok (allowed in dev)", () => {
    const result = checkStartupGuards(safeEnv({ jwtJwksUrl: JWKS, jwtAudience: undefined, nodeEnv: "development" }));
    expect(result.ok).toBe(true);
  });

  test("JWT_JWKS_URL + JWT_AUDIENCE both set + NODE_ENV=production → ok", () => {
    const result = checkStartupGuards(safeEnv({ jwtJwksUrl: JWKS, jwtAudience: "mcp-bridge", nodeEnv: "production" }));
    expect(result.ok).toBe(true);
  });

  test("no JWT_JWKS_URL (inbound JWT disabled) + NODE_ENV=production → ok even without audience", () => {
    const result = checkStartupGuards(
      safeEnv({ jwtJwksUrl: undefined, jwtAudience: undefined, nodeEnv: "production" }),
    );
    expect(result.ok).toBe(true);
  });

  test("JWT_JWKS_URL without audience + ALLOW_UNSAFE_JWT_NO_AUDIENCE=true + production → ok (escape hatch)", () => {
    process.env.ALLOW_UNSAFE_JWT_NO_AUDIENCE = "true";
    const result = checkStartupGuards(safeEnv({ jwtJwksUrl: JWKS, jwtAudience: undefined, nodeEnv: "production" }));
    expect(result.ok).toBe(true);
  });

  test("JWT audience reason includes the cross-audience explanation and remediation chunks", () => {
    const r = checkStartupGuards(safeEnv({ jwtJwksUrl: JWKS, jwtAudience: undefined, nodeEnv: "production" }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain("cross-audience privilege grant");
      expect(r.reason).toContain("ALLOW_UNSAFE_JWT_NO_AUDIENCE=true");
    }
  });
});

// ---------------------------------------------------------------------------
// All-safe baseline
// ---------------------------------------------------------------------------

describe("checkStartupGuards — all safe", () => {
  test("safe defaults in production → ok", () => {
    const result = checkStartupGuards(safeEnv());
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Guard priority — AUTH_DISABLED fires before CORS wildcard
// ---------------------------------------------------------------------------

describe("checkStartupGuards — guard ordering", () => {
  test("AUTH_DISABLED fires before CORS wildcard when both are set", () => {
    const result = checkStartupGuards(safeEnv({ authDisabled: true, corsOrigins: ["*"], nodeEnv: "production" }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("AUTH_DISABLED");
    }
  });
});

// ---------------------------------------------------------------------------
// Reason-message content + string-form CORS (mutation backstop)
//
// Each `reason` is 2-3 concatenated string literals; the base tests above only
// assert one substring, so the OTHER chunks' `StringLiteral -> ""` mutants
// survive. Assert a substring from every chunk of every reason. Plus a bare
// (non-array) corsOrigins to exercise the `[env.corsOrigins]` wrap.
// ---------------------------------------------------------------------------

describe("checkStartupGuards — reason content + string CORS", () => {
  test("AUTH_DISABLED reason includes both chunks (kills L37+L38)", () => {
    const r = checkStartupGuards(safeEnv({ authDisabled: true, nodeEnv: "production" }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain("all endpoints unauthenticated");
      expect(r.reason).toContain("Refusing to start unless ALLOW_UNSAFE_AUTH_DISABLED=true");
    }
  });

  test("CORS reason includes all three chunks (kills L49+L50+L51)", () => {
    const r = checkStartupGuards(safeEnv({ corsOrigins: ["*"], nodeEnv: "production" }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain("is active outside the development environment");
      expect(r.reason).toContain("All cross-origin requests will be permitted");
      expect(r.reason).toContain("Restrict CORS_ORIGINS to explicit origins");
    }
  });

  test("TRUST_PROXY reason includes the remediation chunk (kills L61)", () => {
    const r = checkStartupGuards(safeEnv({ trustProxy: true, nodeEnv: "production" }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain("named preset");
      expect(r.reason).toContain("numeric hop count");
    }
  });

  test("SESSION_COOKIE reason includes both chunks (kills L72+L73)", () => {
    const r = checkStartupGuards(safeEnv({ sessionCookieSecure: false, nodeEnv: "production" }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain("admin session cookies would be sent over");
      expect(r.reason).toContain("plain HTTP");
    }
  });

  test("a bare-string corsOrigins='*' still fires the CORS guard (kills L44 ArrayDeclaration->[])", () => {
    // The `[env.corsOrigins]` wrap only runs for a non-array corsOrigins; the
    // `-> []` mutant makes origins empty so the wildcard check never fires.
    const r = checkStartupGuards(safeEnv({ corsOrigins: "*", nodeEnv: "production" }));
    expect(r.ok).toBe(false);
  });
});
