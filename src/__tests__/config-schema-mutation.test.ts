import { describe, test, expect, spyOn } from "bun:test";
import { validateEnv, validateEnvOrWarn, validateEnvStrict } from "../config-schema.js";
import * as logger from "../logger.js";

// This file gap-fills src/__tests__/config-schema.test.ts (left untouched) for
// Stryker mutation coverage of src/config-schema.ts. It targets:
//  - envInt boundary/clause isolation (min/max, isFinite vs isInteger, "" default)
//  - envBool case-sensitivity and explicit "true"/"false"
//  - envUrl success/failure paths + error message text
//  - envEnum "" (uses default) vs explicit non-default value + error message text
//  - unknown-env-detection edge cases (allowed-key precedence, extra prefixes)
//  - validateEnvOrWarn's logging call counts/format (aggregate line gating)
//  - validateEnvStrict's thrown message content + STRICT_CONFIG/errors-only gating
//
// IMPORTANT environment note (read before "fixing" a failure here): the zod
// version resolved in this worktree treats a KEY THAT IS ENTIRELY ABSENT from
// the input object as a validation failure ("expected nonoptional, received
// undefined") even though every field in EnvSchema is
// `z.union([z.string(), z.undefined()])` (which — per this file's own design
// comment — is meant to accept a present-but-undefined value OR an absent
// key equally, config.ts / process.env semantics). This is the exact,
// documented root cause behind config-schema.test.ts's 5 pre-existing
// failures (schema-basics x4 + validateEnvStrict x1) — every one of them
// calls `validateEnv`/`validateEnvStrict` with a PARTIAL env object and then
// asserts `ok`/`errors === []`, which trips this zod artifact because dozens
// of other schema keys are simply missing from the object literal.
//
// To get real, meaningful, PASSING assertions about `ok`/`errors` in this
// same environment, every test below that needs a "clean" baseline builds it
// from FULL_VALID_ENV (every schema key explicitly present with a valid
// value) and only overrides the field(s) actually under test. A key present
// with an explicit `undefined` *value* (as opposed to omitted entirely) is
// NOT affected by this artifact — verified empirically — so that pattern is
// used wherever the `raw === undefined` branch itself needs exercising.
const BOOL_KEYS = new Set([
  "AUTH_DISABLED",
  "SESSION_COOKIE_SECURE",
  "ALLOW_UNSAFE_INSECURE_SESSION_COOKIE",
  "ALLOW_UNSAFE_AUTH_DISABLED",
  "ALLOW_PRIVATE_IPS",
  "ALLOW_UNSAFE_CORS_WILDCARD",
  "CORS_ALLOW_CREDENTIALS",
  "RATE_LIMIT_SHARED",
  "REGISTRY_SYNC",
  "AUTO_GATE_WRITE_METHODS",
  "ENABLE_SEARCH_TOOL",
  "METRICS_ENABLED",
  "TRACE_STORAGE",
  "TRAFFIC_CAPTURE",
]);

// Every key EnvSchema declares. envInt/envCsv/envUrl/envOptString/envEnum all
// treat "" as "use the default" (no validation failure), so "" is a safe
// blanket value for every non-boolean field; envBool requires an explicit
// "true"/"false" literal, hence BOOL_KEYS above.
const ALL_KEYS = [
  "PORT",
  "NODE_ENV",
  "AUTH_DISABLED",
  "ADMIN_API_KEYS",
  "MCP_API_KEYS",
  "SESSION_TTL_MS",
  "MAX_SESSIONS",
  "SESSION_IDLE_TIMEOUT_MS",
  "SESSION_ABSOLUTE_TTL_MS",
  "SESSION_COOKIE_SECURE",
  "ALLOW_UNSAFE_INSECURE_SESSION_COOKIE",
  "ALLOW_UNSAFE_AUTH_DISABLED",
  "BOOTSTRAP_ADMIN_USERNAME",
  "BOOTSTRAP_ADMIN_PASSWORD",
  "ALLOW_PRIVATE_IPS",
  "ALLOWED_HOSTS",
  "ALLOWED_ORIGINS",
  "CORS_ORIGINS",
  "ALLOW_UNSAFE_CORS_WILDCARD",
  "CORS_ALLOW_CREDENTIALS",
  "CORS_MAX_AGE_SECONDS",
  "TRUST_PROXY",
  "TOOL_CALL_TIMEOUT_MS",
  "HEALTH_CHECK_TIMEOUT_MS",
  "HEALTH_CHECK_INTERVAL_MS",
  "HEALTH_CHECK_MAX_CONCURRENT",
  "OPENAPI_DISCOVERY_TIMEOUT_MS",
  "GRAPHQL_DISCOVERY_TIMEOUT_MS",
  "RATE_LIMIT_REGISTER",
  "RATE_LIMIT_MCP",
  "RATE_LIMIT_GLOBAL",
  "RATE_LIMIT_LOGIN",
  "RATE_LIMIT_INSTALL_LINK",
  "RATE_LIMIT_MAX_BUCKETS_GLOBAL",
  "RATE_LIMIT_MAX_BUCKETS_MCP",
  "RATE_LIMIT_MAX_BUCKETS_REGISTER",
  "RATE_LIMIT_MAX_BUCKETS_LOGIN",
  "RATE_LIMIT_MAX_BUCKETS_INSTALL_LINK",
  "RATE_LIMIT_MAX_BUCKETS_TOOL",
  "RATE_LIMIT_CLEANUP_INTERVAL_MS",
  "RATE_LIMIT_SHARED",
  "MAX_RESPONSE_BYTES",
  "MAX_TOOLS_PER_CLIENT",
  "MAX_CONSECUTIVE_FAILURES",
  "MAX_JSON_DEPTH",
  "GRAPHQL_MAX_TYPES",
  "GRAPHQL_SELECTION_MAX_DEPTH",
  "GRAPHQL_INPUT_MAX_DEPTH",
  "RETRY_MAX_ATTEMPTS",
  "RETRY_BASE_DELAY_MS",
  "RETRY_AFTER_MAX_MS",
  "CACHE_MAX_ENTRIES",
  "LB_TARGET_COOLDOWN_MS",
  "WS_PROXY_MAX_GLOBAL_CONNECTIONS",
  "WS_PROXY_DEFAULT_MAX_CONNECTIONS",
  "WS_PROXY_DEFAULT_MAX_MESSAGE_BYTES",
  "WS_PROXY_DEFAULT_IDLE_TIMEOUT_MS",
  "WS_PROXY_DIAL_TIMEOUT_MS",
  "WS_PROXY_REVALIDATE_INTERVAL_MS",
  "CIRCUIT_BREAKER_WINDOW_MS",
  "CIRCUIT_BREAKER_FAILURE_THRESHOLD",
  "CIRCUIT_BREAKER_RESET_TIMEOUT_MS",
  "CIRCUIT_BREAKER_HALF_OPEN_TIMEOUT_MS",
  "SHUTDOWN_FORCE_EXIT_MS",
  "LEADER_LEASE_DURATION_MS",
  "INSTANCE_ID",
  "REGISTRY_SYNC",
  "REGISTRY_SYNC_INTERVAL_MS",
  "AUTO_GATE_WRITE_METHODS",
  "ENABLE_SEARCH_TOOL",
  "GATEWAY_PUBLIC_URL",
  "CONTEXT_BUDGET_LLM_TIMEOUT_MS",
  "METRICS_ENABLED",
  "LOG_FORMAT",
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "OTEL_SERVICE_NAME",
  "OTEL_MAX_BATCH",
  "OTEL_EXPORT_TIMEOUT_MS",
  "TRACE_STORAGE",
  "TRACE_RETENTION_MS",
  "TRAFFIC_CAPTURE",
  "TRAFFIC_MAX_BODY_BYTES",
  "TRAFFIC_RETENTION_MS",
  "APPROVAL_WEBHOOK_URL",
  "APPROVAL_WEBHOOK_TIMEOUT_MS",
  "MONITOR_WEBHOOK_URL",
  "MONITOR_WEBHOOK_TIMEOUT_MS",
  "AUDIT_SINK_URL",
  "AUDIT_SINK_TIMEOUT_MS",
  "ALERT_INTERVAL_MS",
  "ALERT_WEBHOOK_TIMEOUT_MS",
  "ALERT_ERROR_RATE_WINDOW_MS",
  "ANOMALY_RECENT_WINDOW_MS",
  "ANOMALY_BASELINE_WINDOW_MS",
  "USAGE_RETENTION_MS",
  "JWT_JWKS_URL",
  "JWT_ISSUER",
  "JWT_AUDIENCE",
  "JWT_JWKS_CACHE_MS",
  "JWT_JWKS_TIMEOUT_MS",
  "OAUTH_TOKEN_TIMEOUT_MS",
  "SECRET_ENCRYPTION_KEY",
  "SECRETS_PROVIDER",
  "VAULT_ADDR",
  "VAULT_TOKEN",
  "VAULT_TRANSIT_KEY_NAME",
  "VAULT_REQUEST_TIMEOUT_MS",
  "DB_PATH",
] as const;

const FULL_VALID_ENV: NodeJS.ProcessEnv = {};
for (const k of ALL_KEYS) FULL_VALID_ENV[k] = BOOL_KEYS.has(k) ? "false" : "";

test("sanity: FULL_VALID_ENV baseline fixture is itself internally valid", () => {
  const report = validateEnv(FULL_VALID_ENV);
  expect(report.ok).toBe(true);
  expect(report.errors).toEqual([]);
  expect(report.unknown).toEqual([]);
});

// ─── envInt ─────────────────────────────────────────────────────────────────

describe("envInt — boundaries and clause isolation", () => {
  test("exact min boundary is accepted", () => {
    const report = validateEnv({ ...FULL_VALID_ENV, RATE_LIMIT_REGISTER: "1" });
    expect(report.ok).toBe(true);
    expect(report.errors).toEqual([]);
  });

  test("exact max boundary is accepted", () => {
    const report = validateEnv({ ...FULL_VALID_ENV, RATE_LIMIT_REGISTER: "100000" });
    expect(report.ok).toBe(true);
    expect(report.errors).toEqual([]);
  });

  test("one below min is rejected", () => {
    const report = validateEnv({ ...FULL_VALID_ENV, RATE_LIMIT_REGISTER: "0" });
    expect(report.ok).toBe(false);
    expect(report.errors).toEqual([{ key: "RATE_LIMIT_REGISTER", message: "expected integer in [1, 100000], got 0" }]);
  });

  test("one above max is rejected", () => {
    const report = validateEnv({ ...FULL_VALID_ENV, RATE_LIMIT_REGISTER: "100001" });
    expect(report.ok).toBe(false);
    expect(report.errors).toEqual([
      { key: "RATE_LIMIT_REGISTER", message: "expected integer in [1, 100000], got 100001" },
    ]);
  });

  test("negative value below min is rejected", () => {
    const report = validateEnv({ ...FULL_VALID_ENV, PORT: "-1" });
    expect(report.ok).toBe(false);
    expect(report.errors).toEqual([{ key: "PORT", message: "expected integer in [1, 65535], got -1" }]);
  });

  // The bound arguments below are computed with multiplication (e.g.
  // `30 * 86_400_000`); accepting the REAL computed max at its exact boundary
  // pins down the arithmetic itself (a corrupted operator — e.g. `/` for `*`
  // — would shrink the max to a fraction and turn this into a spurious
  // out-of-range error).
  test("SESSION_ABSOLUTE_TTL_MS accepts its real computed max (30 * 86_400_000)", () => {
    const report = validateEnv({ ...FULL_VALID_ENV, SESSION_ABSOLUTE_TTL_MS: "2592000000" });
    expect(report.ok).toBe(true);
    expect(report.errors).toEqual([]);
  });

  test("TRACE_RETENTION_MS accepts its real computed max (30 * 86_400_000)", () => {
    const report = validateEnv({ ...FULL_VALID_ENV, TRACE_RETENTION_MS: "2592000000" });
    expect(report.ok).toBe(true);
    expect(report.errors).toEqual([]);
  });

  test("TRAFFIC_RETENTION_MS accepts its real computed max (365 * 86_400_000)", () => {
    const report = validateEnv({ ...FULL_VALID_ENV, TRAFFIC_RETENTION_MS: "31536000000" });
    expect(report.ok).toBe(true);
    expect(report.errors).toEqual([]);
  });

  test("ANOMALY_BASELINE_WINDOW_MS accepts its real computed max (30 * 86_400_000)", () => {
    const report = validateEnv({ ...FULL_VALID_ENV, ANOMALY_BASELINE_WINDOW_MS: "2592000000" });
    expect(report.ok).toBe(true);
    expect(report.errors).toEqual([]);
  });

  test("USAGE_RETENTION_MS accepts its real computed max (365 * 86_400_000)", () => {
    const report = validateEnv({ ...FULL_VALID_ENV, USAGE_RETENTION_MS: "31536000000" });
    expect(report.ok).toBe(true);
    expect(report.errors).toEqual([]);
  });

  test("empty string uses the default (no error) — same as the baseline fixture", () => {
    const report = validateEnv({ ...FULL_VALID_ENV, SESSION_TTL_MS: "" });
    expect(report.ok).toBe(true);
    expect(report.errors).toEqual([]);
  });

  test("decimal (finite but non-integer) is rejected distinctly from NaN", () => {
    const report = validateEnv({ ...FULL_VALID_ENV, RATE_LIMIT_REGISTER: "5.5" });
    expect(report.ok).toBe(false);
    expect(report.errors).toEqual([{ key: "RATE_LIMIT_REGISTER", message: 'expected integer, got "5.5"' }]);
  });

  test("non-numeric string error message names the field and raw value", () => {
    const report = validateEnv({ ...FULL_VALID_ENV, PORT: "abc" });
    expect(report.errors).toEqual([{ key: "PORT", message: `expected integer, got ${JSON.stringify("abc")}` }]);
  });

  test("out-of-range error message reports the actual bounds and value", () => {
    const report = validateEnv({ ...FULL_VALID_ENV, PORT: "99999" });
    expect(report.errors).toEqual([{ key: "PORT", message: "expected integer in [1, 65535], got 99999" }]);
  });

  test("a key present with an explicit undefined value uses the default without error", () => {
    // Distinguishes the `raw === undefined` clause from the `raw === ""` clause:
    // this exercises the former without omitting the key outright (omitting a
    // key entirely trips an unrelated zod-version artifact — see file banner).
    const env = { ...FULL_VALID_ENV, PORT: undefined };
    const report = validateEnv(env);
    expect(report.ok).toBe(true);
    expect(report.errors.some((e) => e.key === "PORT")).toBe(false);
  });
});

// ─── envBool ────────────────────────────────────────────────────────────────

describe("envBool — case sensitivity and explicit true/false", () => {
  test("explicit true is accepted", () => {
    const report = validateEnv({ ...FULL_VALID_ENV, AUTH_DISABLED: "true" });
    expect(report.ok).toBe(true);
    expect(report.errors).toEqual([]);
  });

  test("explicit false is accepted", () => {
    const report = validateEnv({ ...FULL_VALID_ENV, SESSION_COOKIE_SECURE: "false" });
    expect(report.ok).toBe(true);
    expect(report.errors).toEqual([]);
  });

  test("wrong-case True is rejected (case-sensitive match only)", () => {
    const report = validateEnv({ ...FULL_VALID_ENV, AUTH_DISABLED: "True" });
    expect(report.ok).toBe(false);
    expect(report.errors.some((e) => e.key === "AUTH_DISABLED")).toBe(true);
  });

  test("wrong-case FALSE is rejected", () => {
    const report = validateEnv({ ...FULL_VALID_ENV, AUTH_DISABLED: "FALSE" });
    expect(report.ok).toBe(false);
    expect(report.errors.some((e) => e.key === "AUTH_DISABLED")).toBe(true);
  });

  test("numeric-ish '0'/'1' are rejected, not coerced", () => {
    const report1 = validateEnv({ ...FULL_VALID_ENV, REGISTRY_SYNC: "1" });
    expect(report1.ok).toBe(false);
    expect(report1.errors.some((e) => e.key === "REGISTRY_SYNC")).toBe(true);

    const report0 = validateEnv({ ...FULL_VALID_ENV, REGISTRY_SYNC: "0" });
    expect(report0.ok).toBe(false);
    expect(report0.errors.some((e) => e.key === "REGISTRY_SYNC")).toBe(true);
  });

  test("'yes' is rejected", () => {
    const report = validateEnv({ ...FULL_VALID_ENV, TRACE_STORAGE: "yes" });
    expect(report.ok).toBe(false);
    expect(report.errors.some((e) => e.key === "TRACE_STORAGE")).toBe(true);
  });

  test("a key present with an explicit undefined value is accepted with no error", () => {
    const env = { ...FULL_VALID_ENV, TRACE_STORAGE: undefined };
    const report = validateEnv(env);
    expect(report.ok).toBe(true);
    expect(report.errors.some((e) => e.key === "TRACE_STORAGE")).toBe(false);
  });
});

// ─── envUrl ─────────────────────────────────────────────────────────────────

describe("envUrl", () => {
  test("well-formed URL is accepted", () => {
    const report = validateEnv({ ...FULL_VALID_ENV, GATEWAY_PUBLIC_URL: "https://gateway.example.com" });
    expect(report.ok).toBe(true);
    expect(report.errors).toEqual([]);
  });

  test("malformed URL is rejected with a descriptive message", () => {
    const report = validateEnv({ ...FULL_VALID_ENV, GATEWAY_PUBLIC_URL: "not-a-url" });
    expect(report.ok).toBe(false);
    expect(report.errors).toEqual([
      { key: "GATEWAY_PUBLIC_URL", message: `expected URL, got ${JSON.stringify("not-a-url")}` },
    ]);
  });

  test("empty string is treated as absent (no error) — same as baseline", () => {
    const report = validateEnv({ ...FULL_VALID_ENV, OTEL_EXPORTER_OTLP_ENDPOINT: "" });
    expect(report.ok).toBe(true);
    expect(report.errors).toEqual([]);
  });

  test("a key present with an explicit undefined value is accepted with no error", () => {
    const env = { ...FULL_VALID_ENV, VAULT_ADDR: undefined };
    const report = validateEnv(env);
    expect(report.ok).toBe(true);
    expect(report.errors.some((e) => e.key === "VAULT_ADDR")).toBe(false);
  });

  test("SECRETS_PROVIDER=vault with a well-formed VAULT_ADDR is accepted together", () => {
    const report = validateEnv({
      ...FULL_VALID_ENV,
      SECRETS_PROVIDER: "vault",
      VAULT_ADDR: "https://vault.example.com",
    });
    expect(report.ok).toBe(true);
    expect(report.errors).toEqual([]);
  });
});

// ─── envEnum ────────────────────────────────────────────────────────────────

describe("envEnum", () => {
  test("empty string falls back to the default (no error) — same as baseline", () => {
    const report = validateEnv({ ...FULL_VALID_ENV, LOG_FORMAT: "" });
    expect(report.ok).toBe(true);
    expect(report.errors).toEqual([]);
  });

  test("explicit non-default valid value is accepted", () => {
    const report = validateEnv({ ...FULL_VALID_ENV, LOG_FORMAT: "text" });
    expect(report.ok).toBe(true);
    expect(report.errors).toEqual([]);
  });

  test("invalid enum value message lists the allowed values and the given one", () => {
    const report = validateEnv({ ...FULL_VALID_ENV, LOG_FORMAT: "yaml" });
    expect(report.errors).toEqual([
      { key: "LOG_FORMAT", message: `expected one of json, text, got ${JSON.stringify("yaml")}` },
    ]);
  });

  test("SECRETS_PROVIDER explicit default value ('local') is accepted", () => {
    const report = validateEnv({ ...FULL_VALID_ENV, SECRETS_PROVIDER: "local" });
    expect(report.ok).toBe(true);
    expect(report.errors).toEqual([]);
  });

  test("invalid SECRETS_PROVIDER message names both the invalid value and the allowed set", () => {
    const report = validateEnv({ ...FULL_VALID_ENV, SECRETS_PROVIDER: "hashicorp" });
    expect(report.errors).toEqual([
      { key: "SECRETS_PROVIDER", message: `expected one of local, vault, got ${JSON.stringify("hashicorp")}` },
    ]);
  });

  test("a key present with an explicit undefined value uses the default without error", () => {
    const env = { ...FULL_VALID_ENV, LOG_FORMAT: undefined };
    const report = validateEnv(env);
    expect(report.ok).toBe(true);
    expect(report.errors.some((e) => e.key === "LOG_FORMAT")).toBe(false);
  });
});

// ─── Unknown-env detection edge cases ───────────────────────────────────────

describe("validateEnv — unknown detection edge cases", () => {
  test("a real schema key that also matches a prefix is never reported unknown", () => {
    // AUTH_DISABLED both is a schema key AND starts with the "AUTH_" prefix —
    // the allowed-set check must win (continue) before the prefix scan runs.
    const report = validateEnv(FULL_VALID_ENV);
    expect(report.unknown.some((u) => u.key === "AUTH_DISABLED")).toBe(false);
  });

  test("bare RETENTION-prefixed var (no trailing underscore in schema list) is flagged", () => {
    const report = validateEnv({ ...FULL_VALID_ENV, RETENTION_FOO: "x" });
    expect(report.ok).toBe(true);
    expect(report.unknown).toEqual([
      {
        key: "RETENTION_FOO",
        message: "env var is set but not declared in the bridge schema (typo or removed config?)",
      },
    ]);
  });

  test("PROXY_-prefixed unknown var is flagged", () => {
    const report = validateEnv({ ...FULL_VALID_ENV, PROXY_FAKE: "x" });
    expect(report.unknown.some((u) => u.key === "PROXY_FAKE")).toBe(true);
  });

  test("MIN_-prefixed unknown var is flagged", () => {
    const report = validateEnv({ ...FULL_VALID_ENV, MIN_FAKE: "x" });
    expect(report.unknown.some((u) => u.key === "MIN_FAKE")).toBe(true);
  });

  test("HSTS_-prefixed unknown var is flagged", () => {
    const report = validateEnv({ ...FULL_VALID_ENV, HSTS_FAKE: "x" });
    expect(report.unknown.some((u) => u.key === "HSTS_FAKE")).toBe(true);
  });

  test("GATEWAY_-prefixed unknown var is flagged (distinct from the allowed GATEWAY_PUBLIC_URL key)", () => {
    const report = validateEnv({ ...FULL_VALID_ENV, GATEWAY_FAKE: "x" });
    expect(report.unknown.some((u) => u.key === "GATEWAY_FAKE")).toBe(true);
    expect(report.unknown.some((u) => u.key === "GATEWAY_PUBLIC_URL")).toBe(false);
  });

  test("unknown detection has no effect on `ok` — only schema errors do", () => {
    const report = validateEnv({ ...FULL_VALID_ENV, MCP_FAKE_SETTING: "yes" });
    expect(report.unknown.length).toBeGreaterThan(0);
    expect(report.ok).toBe(true);
    expect(report.errors).toEqual([]);
  });

  test("two distinct unknown vars both surface independently (not just the first)", () => {
    const report = validateEnv({ ...FULL_VALID_ENV, MCP_FAKE_ONE: "a", MCP_FAKE_TWO: "b" });
    expect(report.unknown.some((u) => u.key === "MCP_FAKE_ONE")).toBe(true);
    expect(report.unknown.some((u) => u.key === "MCP_FAKE_TWO")).toBe(true);
    expect(report.unknown.length).toBe(2);
  });

  test("ordinary non-bridge env vars (PATH, HOME, npm_config_x) are never flagged unknown", () => {
    // This single assertion kills every prefix-string mutant in the internal
    // `prefixes` array at once: corrupting ANY one prefix literal to "" makes
    // `k.startsWith("")` true for every key (since every string starts with
    // the empty string), which would incorrectly flag these ordinary vars.
    // It also kills a mutant that forces the "no prefix matched" guard to
    // never skip (which has the same "everything gets flagged" effect).
    const report = validateEnv({
      ...FULL_VALID_ENV,
      PATH: "C:\\Windows",
      HOME: "/home/me",
      npm_config_x: "1",
      SOME_RANDOM_VAR: "y",
    });
    expect(report.unknown).toEqual([]);
  });

  test("a non-object input (e.g. an array) reports a root-level error under the '<root>' key", () => {
    // Exercises `String(issue.path[0] ?? \"<root>\")`: EnvSchema is a plain
    // z.object, so every real field-level issue has path[0] set; the only way
    // to reach the "<root>" fallback is a whole-input type mismatch.
    const report = validateEnv([] as unknown as NodeJS.ProcessEnv);
    expect(report.ok).toBe(false);
    expect(report.errors.some((e) => e.key === "<root>")).toBe(true);
  });
});

// ─── validateEnvOrWarn — logging behavior ───────────────────────────────────

describe("validateEnvOrWarn — logging call counts and format", () => {
  test("logs one warn per error, with the 'Env validation: KEY — message' format", () => {
    const logSpy = spyOn(logger, "log").mockImplementation(() => {});
    try {
      validateEnvOrWarn({ ...FULL_VALID_ENV, PORT: "abc" });
      const calls = logSpy.mock.calls.filter((c) => c[0] === "warn");
      expect(calls.some((c) => c[1] === `Env validation: PORT — expected integer, got ${JSON.stringify("abc")}`)).toBe(
        true,
      );
    } finally {
      logSpy.mockRestore();
    }
  });

  test("logs one warn per unknown var, with the 'Env validation: unknown KEY' format", () => {
    const logSpy = spyOn(logger, "log").mockImplementation(() => {});
    try {
      validateEnvOrWarn({ ...FULL_VALID_ENV, MCP_FAKE_SETTING: "x" });
      const calls = logSpy.mock.calls.filter((c) => c[0] === "warn");
      expect(calls.some((c) => c[1] === "Env validation: unknown MCP_FAKE_SETTING")).toBe(true);
    } finally {
      logSpy.mockRestore();
    }
  });

  test("does NOT log the aggregate summary line when there are only unknowns (no errors)", () => {
    const logSpy = spyOn(logger, "log").mockImplementation(() => {});
    try {
      validateEnvOrWarn({ ...FULL_VALID_ENV, MCP_FAKE_SETTING: "x" });
      const calls = logSpy.mock.calls.filter((c) => c[0] === "warn");
      // Exactly one call: the per-unknown warning. No aggregate summary line.
      expect(calls.length).toBe(1);
      expect(calls.some((c) => typeof c[1] === "string" && c[1].includes("Env validation found"))).toBe(false);
    } finally {
      logSpy.mockRestore();
    }
  });

  test("DOES log the aggregate summary line when there is at least one error, with correct counts", () => {
    const logSpy = spyOn(logger, "log").mockImplementation(() => {});
    try {
      validateEnvOrWarn({ ...FULL_VALID_ENV, PORT: "abc", MCP_FAKE_SETTING: "x" });
      const calls = logSpy.mock.calls.filter((c) => c[0] === "warn");
      const summary = calls.find((c) => typeof c[1] === "string" && c[1].includes("Env validation found"));
      expect(summary).toBeDefined();
      expect(summary?.[1]).toContain("found 1 invalid and 1 unknown env var(s)");
      expect(summary?.[1]).toContain("Continuing boot");
      expect(summary?.[1]).toContain("STRICT_CONFIG=production");
      // Total calls: 1 (error) + 1 (unknown) + 1 (aggregate) = 3.
      expect(calls.length).toBe(3);
    } finally {
      logSpy.mockRestore();
    }
  });

  test("multiple errors and zero unknowns still logs exactly one aggregate line with the right counts", () => {
    const logSpy = spyOn(logger, "log").mockImplementation(() => {});
    try {
      validateEnvOrWarn({ ...FULL_VALID_ENV, PORT: "abc", LOG_FORMAT: "yaml" });
      const calls = logSpy.mock.calls.filter((c) => c[0] === "warn");
      const summaries = calls.filter((c) => typeof c[1] === "string" && c[1].includes("Env validation found"));
      expect(summaries.length).toBe(1);
      expect(summaries[0]?.[1]).toContain("found 2 invalid and 0 unknown env var(s)");
      // 1 (PORT) + 1 (LOG_FORMAT) + 1 (aggregate) = 3.
      expect(calls.length).toBe(3);
    } finally {
      logSpy.mockRestore();
    }
  });

  test("fully valid + fully known env logs nothing at all", () => {
    const logSpy = spyOn(logger, "log").mockImplementation(() => {});
    try {
      validateEnvOrWarn(FULL_VALID_ENV);
      expect(logSpy.mock.calls.length).toBe(0);
    } finally {
      logSpy.mockRestore();
    }
  });

  test("returns the same report shape validateEnv would produce (not just a side-effecting void)", () => {
    const logSpy = spyOn(logger, "log").mockImplementation(() => {});
    try {
      const r = validateEnvOrWarn({ ...FULL_VALID_ENV, PORT: "abc" });
      expect(r.ok).toBe(false);
      expect(r.errors).toEqual([{ key: "PORT", message: `expected integer, got ${JSON.stringify("abc")}` }]);
    } finally {
      logSpy.mockRestore();
    }
  });
});

// ─── validateEnvStrict — throw gating and message content ──────────────────

describe("validateEnvStrict — throw gating and message content", () => {
  test("throws when STRICT_CONFIG=production and exactly one field fails", () => {
    expect(() => validateEnvStrict({ ...FULL_VALID_ENV, PORT: "abc", STRICT_CONFIG: "production" })).toThrow(
      /STRICT_CONFIG=production/,
    );
  });

  test("does not throw when STRICT_CONFIG=production but there are only unknown vars (no errors)", () => {
    expect(() =>
      validateEnvStrict({ ...FULL_VALID_ENV, MCP_FAKE_SETTING: "x", STRICT_CONFIG: "production" }),
    ).not.toThrow();
  });

  test("does not throw when STRICT_CONFIG has an unrelated truthy-looking value", () => {
    expect(() => validateEnvStrict({ ...FULL_VALID_ENV, PORT: "abc", STRICT_CONFIG: "true" })).not.toThrow();
  });

  test("does not throw on a fully valid env even with STRICT_CONFIG=production", () => {
    expect(() => validateEnvStrict({ ...FULL_VALID_ENV, STRICT_CONFIG: "production" })).not.toThrow();
  });

  test("thrown message includes the exact error count and each key: message pair, semicolon-joined", () => {
    let thrown: unknown;
    try {
      validateEnvStrict({ ...FULL_VALID_ENV, PORT: "abc", LOG_FORMAT: "yaml", STRICT_CONFIG: "production" });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toBe(
      "STRICT_CONFIG=production: 2 env var(s) failed validation. " +
        `PORT: expected integer, got ${JSON.stringify("abc")}; ` +
        `LOG_FORMAT: expected one of json, text, got ${JSON.stringify("yaml")}`,
    );
  });

  test("still returns the report (not just throwing) when validation fails without STRICT_CONFIG", () => {
    const r = validateEnvStrict({ ...FULL_VALID_ENV, PORT: "abc" });
    expect(r.ok).toBe(false);
    expect(r.errors).toEqual([{ key: "PORT", message: `expected integer, got ${JSON.stringify("abc")}` }]);
  });

  test("default parameter (no env arg) does not throw synchronously", () => {
    // Exercises the `env: NodeJS.ProcessEnv = process.env` default branch.
    expect(() => validateEnvStrict()).not.toThrow();
  });
});

// ─── validateEnv default parameter ──────────────────────────────────────────

describe("validateEnv — default parameter", () => {
  test("called with no argument falls back to process.env without throwing", () => {
    expect(() => validateEnv()).not.toThrow();
  });
});
