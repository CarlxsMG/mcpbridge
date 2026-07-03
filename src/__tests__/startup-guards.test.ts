import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { checkStartupGuards } from "../security/startup-guards.js";
import type { StartupGuardEnv } from "../security/startup-guards.js";

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
    ...overrides,
  };
}

// Ensure ALLOW_UNSAFE_* does not leak between tests
let savedAllowUnsafe: string | undefined;
let savedAllowUnsafeCookie: string | undefined;
beforeEach(() => {
  savedAllowUnsafe = process.env.ALLOW_UNSAFE_AUTH_DISABLED;
  delete process.env.ALLOW_UNSAFE_AUTH_DISABLED;
  savedAllowUnsafeCookie = process.env.ALLOW_UNSAFE_INSECURE_SESSION_COOKIE;
  delete process.env.ALLOW_UNSAFE_INSECURE_SESSION_COOKIE;
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
