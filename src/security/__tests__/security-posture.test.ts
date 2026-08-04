import { describe, test, expect, afterEach } from "bun:test";
import { withConfig } from "../../__tests__/_utils/with-config.js";
import { evaluateSecurityPosture } from "../security-posture.js";

/**
 * The posture reader is pure over config + `isMcpDataPlaneOpen()`, so these
 * tests pin the two things that actually matter and are easy to get wrong:
 * WHICH conditions raise a finding, and — for conditions the startup guards
 * normally refuse — whether the reason they are running is reported correctly.
 *
 * `tolerated` is the subtle half. "Insecure on a laptop" and "insecure in
 * production because someone set an env var months ago" render as the same
 * warning without it, and they are not the same problem.
 */

// Every case that reads NODE_ENV / ALLOW_UNSAFE_* sets it explicitly; restore
// after each so nothing leaks into the shared process (bunfig preloads the
// isolation reset for the db/config/rate-limiter, not for raw env vars).
const TOUCHED_ENV = ["NODE_ENV", "ALLOW_UNSAFE_AUTH_DISABLED", "ALLOW_UNSAFE_INSECURE_SESSION_COOKIE"] as const;
const savedEnv = new Map<string, string | undefined>();
for (const key of TOUCHED_ENV) savedEnv.set(key, process.env[key]);

afterEach(() => {
  for (const key of TOUCHED_ENV) {
    const value = savedEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

/** A config with every reported condition switched OFF — the baseline each case perturbs by one field. */
const SECURE = {
  authDisabled: false,
  corsOrigins: ["https://admin.example.com"],
  corsAllowCredentials: false,
  sessionCookieSecure: true,
  jwtJwksUrl: undefined,
  jwtAudience: undefined,
  trustProxy: "loopback",
  secretEncryptionKey: "x".repeat(44),
  secretsProvider: "local" as const,
  // Any of these three closes the data plane; requireMcpAuth is the cheapest.
  requireMcpAuth: true,
};

function findingIds(): string[] {
  return evaluateSecurityPosture().findings.map((f) => f.id);
}

describe("evaluateSecurityPosture", () => {
  test("a fully-configured instance reports nothing", () => {
    withConfig(SECURE, () => {
      const posture = evaluateSecurityPosture();
      expect(posture.findings).toEqual([]);
      expect(posture.worst).toBeNull();
    });
  });

  test("an unauthenticated MCP data plane is critical and has no escape hatch to blame", () => {
    withConfig({ ...SECURE, requireMcpAuth: false, mcpApiKeys: [] }, () => {
      const posture = evaluateSecurityPosture();
      const finding = posture.findings.find((f) => f.id === "mcp_data_plane_open");
      expect(finding).toBeDefined();
      expect(finding?.severity).toBe("critical");
      // No startup guard covers this one — a fresh install with no keys is
      // allowed by design, which is exactly why it must be reported.
      expect(finding?.tolerated).toBeNull();
      expect(posture.worst).toBe("critical");
    });
  });

  test("AUTH_DISABLED names the escape hatch that let it boot", () => {
    process.env.NODE_ENV = "production";
    process.env.ALLOW_UNSAFE_AUTH_DISABLED = "true";
    withConfig({ ...SECURE, authDisabled: true }, () => {
      const finding = evaluateSecurityPosture().findings.find((f) => f.id === "auth_disabled");
      expect(finding?.severity).toBe("critical");
      expect(finding?.tolerated).toBe("escape_hatch");
    });
  });

  test("the same condition in development is attributed to development, not to a hatch", () => {
    process.env.NODE_ENV = "development";
    process.env.ALLOW_UNSAFE_AUTH_DISABLED = "true";
    withConfig({ ...SECURE, authDisabled: true }, () => {
      // Both apply; development is the likelier and less alarming explanation.
      expect(evaluateSecurityPosture().findings.find((f) => f.id === "auth_disabled")?.tolerated).toBe("development");
    });
  });

  test("a condition running with no dev mode and no hatch reports null, not a false excuse", () => {
    process.env.NODE_ENV = "production";
    delete process.env.ALLOW_UNSAFE_INSECURE_SESSION_COOKIE;
    withConfig({ ...SECURE, sessionCookieSecure: false }, () => {
      const finding = evaluateSecurityPosture().findings.find((f) => f.id === "session_cookie_insecure");
      expect(finding?.severity).toBe("warning");
      expect(finding?.tolerated).toBeNull();
    });
  });

  test("a CORS wildcard escalates from warning to critical when credentials are also allowed", () => {
    withConfig({ ...SECURE, corsOrigins: ["*"], corsAllowCredentials: false }, () => {
      expect(evaluateSecurityPosture().findings.find((f) => f.id === "cors_wildcard")?.severity).toBe("warning");
    });
    // Wildcard + credentials means any site a signed-in admin visits can drive
    // the admin API as them — a different class of problem from a bare wildcard.
    withConfig({ ...SECURE, corsOrigins: ["*"], corsAllowCredentials: true }, () => {
      expect(evaluateSecurityPosture().findings.find((f) => f.id === "cors_wildcard")?.severity).toBe("critical");
    });
  });

  test("JWT without an audience is reported, and setting one clears it", () => {
    withConfig({ ...SECURE, jwtJwksUrl: "https://idp.example.com/jwks" }, () => {
      expect(findingIds()).toContain("jwt_no_audience");
    });
    withConfig({ ...SECURE, jwtJwksUrl: "https://idp.example.com/jwks", jwtAudience: "mcp-gateway" }, () => {
      expect(findingIds()).not.toContain("jwt_no_audience");
    });
  });

  test("only the boolean form of TRUST_PROXY is reported, not a CIDR or hop count", () => {
    withConfig({ ...SECURE, trustProxy: true }, () => {
      expect(findingIds()).toContain("trust_proxy_boolean");
    });
    withConfig({ ...SECURE, trustProxy: 1 }, () => {
      expect(findingIds()).not.toContain("trust_proxy_boolean");
    });
    withConfig({ ...SECURE, trustProxy: "10.0.0.0/8" }, () => {
      expect(findingIds()).not.toContain("trust_proxy_boolean");
    });
  });

  test("a missing secret box is info — a capability limit, not an exposure", () => {
    withConfig({ ...SECURE, secretEncryptionKey: undefined }, () => {
      const posture = evaluateSecurityPosture();
      expect(posture.findings.find((f) => f.id === "secret_box_unset")?.severity).toBe("info");
      // `worst` must stay at info so the admin-UI banner (which only raises on
      // warning/critical) does not put a permanent bar on every page for it.
      expect(posture.worst).toBe("info");
    });
  });

  test("an external secrets provider satisfies the secret-box requirement", () => {
    withConfig({ ...SECURE, secretEncryptionKey: undefined, secretsProvider: "vault" }, () => {
      expect(findingIds()).not.toContain("secret_box_unset");
    });
  });

  test("worst reports the highest severity present, not the first or last found", () => {
    process.env.NODE_ENV = "production";
    withConfig({ ...SECURE, sessionCookieSecure: false, requireMcpAuth: false, mcpApiKeys: [] }, () => {
      const posture = evaluateSecurityPosture();
      expect(posture.findings.length).toBeGreaterThan(1);
      expect(posture.worst).toBe("critical");
    });
  });

  test("every finding carries a summary and a remediation for non-UI consumers", () => {
    withConfig({ ...SECURE, authDisabled: true, corsOrigins: ["*"], sessionCookieSecure: false }, () => {
      const posture = evaluateSecurityPosture();
      expect(posture.findings.length).toBeGreaterThan(0);
      for (const finding of posture.findings) {
        expect(finding.summary.length).toBeGreaterThan(0);
        expect(finding.remediation.length).toBeGreaterThan(0);
      }
    });
  });
});
