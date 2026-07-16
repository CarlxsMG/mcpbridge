import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { validateEnv, validateEnvOrWarn, validateEnvStrict, __envSchemaKeysForTesting } from "../config-schema.js";

// ─── validateEnv (pure) ─────────────────────────────────────────────────────

describe("validateEnv — schema basics", () => {
  test("empty env returns ok with no errors or unknowns", () => {
    const report = validateEnv({});
    expect(report.ok).toBe(true);
    expect(report.errors).toEqual([]);
    expect(report.unknown).toEqual([]);
  });

  test("valid PORT (integer in range) is accepted", () => {
    const report = validateEnv({ PORT: "8080" });
    expect(report.ok).toBe(true);
    expect(report.errors).toEqual([]);
  });

  test("out-of-range PORT (too high) is flagged", () => {
    const report = validateEnv({ PORT: "99999" });
    expect(report.ok).toBe(false);
    expect(report.errors.some((e) => e.key === "PORT")).toBe(true);
  });

  test("non-integer PORT is flagged", () => {
    const report = validateEnv({ PORT: "abc" });
    expect(report.ok).toBe(false);
    expect(report.errors.some((e) => e.key === "PORT")).toBe(true);
  });

  test("SECRET-style env vars that aren't strict booleans are rejected", () => {
    const report = validateEnv({ AUTH_DISABLED: "1" });
    expect(report.ok).toBe(false);
    expect(report.errors.some((e) => e.key === "AUTH_DISABLED")).toBe(true);
  });

  test("AUTH_DISABLED=true parses cleanly", () => {
    const report = validateEnv({ AUTH_DISABLED: "true" });
    expect(report.ok).toBe(true);
  });

  test("LOG_FORMAT outside the enum is rejected", () => {
    const report = validateEnv({ LOG_FORMAT: "yaml" });
    expect(report.ok).toBe(false);
    expect(report.errors.some((e) => e.key === "LOG_FORMAT")).toBe(true);
  });

  test("SECRETS_PROVIDER=vault is accepted", () => {
    const report = validateEnv({ SECRETS_PROVIDER: "vault", VAULT_ADDR: "https://vault.example.com" });
    expect(report.ok).toBe(true);
  });

  test("invalid SECRETS_PROVIDER is flagged", () => {
    const report = validateEnv({ SECRETS_PROVIDER: "hashicorp" });
    expect(report.ok).toBe(false);
    expect(report.errors.some((e) => e.key === "SECRETS_PROVIDER")).toBe(true);
  });
});

// ─── Unknown env detection (typo guard) ─────────────────────────────────────

describe("validateEnv — unknown env detection (typo guard)", () => {
  test("typo'd TOOL_CALL_TIMEOUTMS (missing underscore) is flagged as unknown", () => {
    const report = validateEnv({ TOOL_CALL_TIMEOUTMS: "5000", TOOL_CALL_TIMEOUT_MS: "30000" });
    // The correctly-named variable is fine; the typo is unknown.
    expect(report.errors.filter((e) => e.key === "TOOL_CALL_TIMEOUT_MS")).toEqual([]);
    expect(report.unknown.some((u) => u.key === "TOOL_CALL_TIMEOUTMS")).toBe(true);
  });

  test("unrelated env vars (PATH, HOME) are NOT flagged", () => {
    const report = validateEnv({ PATH: "C:\\Windows", HOME: "C:\\Users\\me" });
    expect(report.unknown).toEqual([]);
  });

  test("arbitrary MCP_-prefixed but undeclared var IS flagged", () => {
    const report = validateEnv({ MCP_FAKE_SETTING: "yes" });
    expect(report.unknown.some((u) => u.key === "MCP_FAKE_SETTING")).toBe(true);
  });
});

// ─── Side-effect-free ───────────────────────────────────────────────────────

describe("validateEnvOrWarn — never throws", () => {
  test("with garbage env, returns report instead of throwing", () => {
    // Should not throw; the function logs warnings but doesn't abort.
    const r = validateEnvOrWarn({ PORT: "not-a-number" });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.key === "PORT")).toBe(true);
  });
});

// ─── Strict mode ────────────────────────────────────────────────────────────

describe("validateEnvStrict", () => {
  test("throws only when STRICT_CONFIG=production AND a field fails", () => {
    expect(() => validateEnvStrict({ PORT: "abc", STRICT_CONFIG: "production" })).toThrow(/STRICT_CONFIG=production/);
  });

  test("does NOT throw without STRICT_CONFIG=production even on invalid env", () => {
    expect(() => validateEnvStrict({ PORT: "abc" })).not.toThrow();
  });

  test("does NOT throw on fully valid env even with STRICT_CONFIG=production", () => {
    expect(() => validateEnvStrict({ STRICT_CONFIG: "production" })).not.toThrow();
  });
});

// ─── Schema ↔ config.ts parity ───────────────────────────────────────────────
//
// config.ts parses env vars; config-schema.ts validates them. They are two
// hand-maintained views of one contract, and nothing but reviewer diligence
// keeps them in sync — until this test. If config.ts reads a `process.env.X`
// that the schema doesn't declare, validateEnv reports X as an "unknown env
// var" (a false operator warning). Lock the invariant in: every env var
// config.ts reads must have a schema key.

describe("EnvSchema ↔ config.ts parity", () => {
  test("every process.env.* read in config.ts has a matching schema key", () => {
    const configSrc = readFileSync(new URL("../config.ts", import.meta.url), "utf8");
    const readNames = new Set([...configSrc.matchAll(/process\.env\.([A-Z][A-Z0-9_]+)/g)].map((m) => m[1]));
    expect(readNames.size).toBeGreaterThan(0); // guards against a broken regex silently passing

    const schemaKeys = new Set(__envSchemaKeysForTesting);
    const missing = [...readNames].filter((name) => !schemaKeys.has(name)).sort();
    expect(missing).toEqual([]);
  });
});
