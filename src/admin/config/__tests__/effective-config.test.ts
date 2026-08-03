/**
 * The effective-config endpoint hands an operator the whole resolved
 * environment, so the only thing that really matters here is that it hands them
 * none of the secrets. These tests are the guard on that.
 */
import { describe, test, expect } from "bun:test";
import { config } from "../../../config.js";
import { getEffectiveConfig, redactedConfigKeys } from "../effective-config.js";

/**
 * Config keys whose NAME matches the secret-ish pattern below but which are
 * genuinely safe to show, each with the reason. Anything matching the pattern
 * that is neither redacted nor listed here fails the structural test — so a
 * secret added to config.ts later cannot quietly start being served.
 */
const NAME_LOOKS_SECRET_BUT_ISNT: Record<string, string> = {
  corsAllowCredentials: "a boolean CORS flag, not a credential",
  oauthTokenTimeoutMs: "a timeout in ms",
  secretsProvider: "the provider name ('local' | 'vault'), not a secret",
  vaultTransitKeyName: "the Transit key's NAME, which is not itself sensitive",
  bootstrapAdminUsername: "a username; the paired password is redacted",
};

const SECRET_NAME_RE = /key|secret|token|password|credential|pass/i;

describe("effective config redaction", () => {
  test("every redacted key exists in config — the denylist cannot rot into naming nothing", () => {
    const configKeys = new Set(Object.keys(config));
    expect(redactedConfigKeys.filter((k) => !configKeys.has(k))).toEqual([]);
  });

  test("every secret-looking config key is redacted, or explicitly acknowledged as safe", () => {
    const unaccounted = Object.keys(config).filter(
      (k) =>
        SECRET_NAME_RE.test(k) &&
        !(redactedConfigKeys as readonly string[]).includes(k) &&
        !(k in NAME_LOOKS_SECRET_BUT_ISNT),
    );
    expect(unaccounted).toEqual([]);
  });

  test("the acknowledged-safe list names only keys that still exist", () => {
    const configKeys = new Set(Object.keys(config));
    expect(Object.keys(NAME_LOOKS_SECRET_BUT_ISNT).filter((k) => !configKeys.has(k))).toEqual([]);
  });

  test("a redacted key reports presence, never its value", () => {
    const previous = config.secretEncryptionKey;
    try {
      config.secretEncryptionKey = "super-secret-value-do-not-leak";
      const entry = getEffectiveConfig().entries.find((e) => e.key === "secretEncryptionKey")!;
      expect(entry.redacted).toBe(true);
      expect(entry.value).toBe("set");
      expect(JSON.stringify(getEffectiveConfig())).not.toContain("super-secret-value-do-not-leak");
    } finally {
      config.secretEncryptionKey = previous;
    }
  });

  test("an unset redacted key reports 'unset', so an operator can tell it is missing", () => {
    const previous = config.secretEncryptionKey;
    try {
      config.secretEncryptionKey = undefined;
      const entry = getEffectiveConfig().entries.find((e) => e.key === "secretEncryptionKey")!;
      expect(entry.value).toBe("unset");
    } finally {
      config.secretEncryptionKey = previous;
    }
  });

  test("an empty API-key array reports 'unset' — [] is no auth material, not configured auth", () => {
    const previous = config.adminApiKeys;
    try {
      config.adminApiKeys = [];
      expect(getEffectiveConfig().entries.find((e) => e.key === "adminApiKeys")!.value).toBe("unset");
      config.adminApiKeys = ["a-real-key"];
      const entry = getEffectiveConfig().entries.find((e) => e.key === "adminApiKeys")!;
      expect(entry.value).toBe("set");
      expect(JSON.stringify(getEffectiveConfig())).not.toContain("a-real-key");
    } finally {
      config.adminApiKeys = previous;
    }
  });

  test("no configured secret value appears anywhere in the serialized payload", () => {
    const sentinels: Record<string, string> = {
      adminApiKeys: "SENTINEL-ADMIN",
      mcpApiKeys: "SENTINEL-MCP",
      secretEncryptionKey: "SENTINEL-ENC",
      vaultToken: "SENTINEL-VAULT",
      bootstrapAdminPassword: "SENTINEL-PW",
    };
    const saved: Record<string, unknown> = {};
    const mutable = config as unknown as Record<string, unknown>;
    try {
      for (const [key, sentinel] of Object.entries(sentinels)) {
        saved[key] = mutable[key];
        mutable[key] = Array.isArray(saved[key]) ? [sentinel] : sentinel;
      }
      const payload = JSON.stringify(getEffectiveConfig());
      for (const sentinel of Object.values(sentinels)) {
        expect(payload).not.toContain(sentinel);
      }
    } finally {
      for (const key of Object.keys(sentinels)) mutable[key] = saved[key];
    }
  });
});

describe("effective config shape", () => {
  test("reports every config key exactly once, sorted, so two instances diff cleanly", () => {
    const { entries } = getEffectiveConfig();
    const keys = entries.map((e) => e.key);
    expect(keys).toEqual([...keys].sort());
    expect(new Set(keys).size).toBe(keys.length);
    expect(new Set(keys)).toEqual(new Set(Object.keys(config)));
  });

  test("non-redacted values pass through unchanged", () => {
    const entry = getEffectiveConfig().entries.find((e) => e.key === "toolCallTimeoutMs")!;
    expect(entry.redacted).toBe(false);
    expect(entry.value).toBe(config.toolCallTimeoutMs);
  });

  test("carries nodeEnv — the most common cause of 'it behaves differently here'", () => {
    expect(typeof getEffectiveConfig().nodeEnv).toBe("string");
  });
});
