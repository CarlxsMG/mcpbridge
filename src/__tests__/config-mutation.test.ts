import { describe, test, expect, beforeAll } from "bun:test";
import { parseCorsOrigins } from "../config.js";

// ---------------------------------------------------------------------------
// Gap-fill for config.ts's exported `config` object.
//
// config-parsers.test.ts already covers `parseCorsOrigins` directly, plus
// (via cache-busting re-imports) the private `parseTrustProxy` and
// `parseSecretsProvider` helpers. This file covers everything else `config`
// exposes: ~90 fields computed once, at module-load time, directly from
// `process.env` (`Number(process.env.X) || default`, `X === "true"`,
// `X !== "false"`, `X?.split(",")... ?? default`, `X || undefined`,
// `X || "literal"`), plus the handful of true constants (corsAllowed*) and
// the `crypto.randomUUID()` fallback for `instanceId`.
//
// Since `config` is a plain object captured once at import time, exercising
// a given env value means importing a BRAND NEW module instance — same
// technique as the sibling file: clear every env var config.ts (or a
// private helper it calls) reads, apply the scenario's overrides, import
// config.ts with a cache-busting query string, then restore the original
// env. Every field is independent (no cross-field validation happens inside
// config.ts itself, apart from `corsOrigins`'s use of `authDisabled`, which
// is exercised deliberately below), so almost the entire object can be
// covered with just a handful of re-imports: one "everything unset"
// (defaults) scenario, one "everything set" (overrides) scenario, and one
// "everything set to the empty string" scenario (which is what actually
// distinguishes `||` from `??` — an empty string is falsy AND non-nullish,
// the one input class where the two operators diverge).
// ---------------------------------------------------------------------------

// Every env var config.ts's module body (or a private helper it calls: only
// `parseCorsOrigins`'s ALLOW_UNSAFE_CORS_WILDCARD escape hatch here — the
// TRUST_PROXY/SECRETS_PROVIDER-specific branches are the sibling file's job)
// reads. Cleared in full before each scenario so no ambient process.env
// state — a real `.env`, `.env.test`'s SESSION_COOKIE_SECURE=true pin, or a
// previous scenario in this same file — can leak into the next import.
const MANAGED_ENV_KEYS = [
  "PORT",
  "TOOL_CALL_TIMEOUT_MS",
  "HEALTH_CHECK_TIMEOUT_MS",
  "HEALTH_CHECK_INTERVAL_MS",
  "HEALTH_CHECK_MAX_CONCURRENT",
  "OPENAPI_DISCOVERY_TIMEOUT_MS",
  "GRAPHQL_DISCOVERY_TIMEOUT_MS",
  "GRAPHQL_MAX_TYPES",
  "GRAPHQL_SELECTION_MAX_DEPTH",
  "GRAPHQL_INPUT_MAX_DEPTH",
  "WS_PROXY_MAX_GLOBAL_CONNECTIONS",
  "WS_PROXY_DEFAULT_MAX_CONNECTIONS",
  "WS_PROXY_DEFAULT_MAX_MESSAGE_BYTES",
  "WS_PROXY_DEFAULT_IDLE_TIMEOUT_MS",
  "WS_PROXY_DIAL_TIMEOUT_MS",
  "WS_PROXY_REVALIDATE_INTERVAL_MS",
  "SESSION_TTL_MS",
  "MAX_SESSIONS",
  "RATE_LIMIT_REGISTER",
  "RATE_LIMIT_MCP",
  "RATE_LIMIT_GLOBAL",
  "MAX_CONSECUTIVE_FAILURES",
  "MAX_RESPONSE_BYTES",
  "RETRY_AFTER_MAX_MS",
  "RETRY_MAX_ATTEMPTS",
  "RETRY_BASE_DELAY_MS",
  "CACHE_MAX_ENTRIES",
  "LB_TARGET_COOLDOWN_MS",
  "APPROVAL_WEBHOOK_TIMEOUT_MS",
  "TRAFFIC_MAX_BODY_BYTES",
  "TRAFFIC_RETENTION_MS",
  "MONITOR_WEBHOOK_TIMEOUT_MS",
  "JWT_JWKS_CACHE_MS",
  "JWT_JWKS_TIMEOUT_MS",
  "OAUTH_TOKEN_TIMEOUT_MS",
  "CIRCUIT_BREAKER_WINDOW_MS",
  "CIRCUIT_BREAKER_FAILURE_THRESHOLD",
  "CIRCUIT_BREAKER_RESET_TIMEOUT_MS",
  "CIRCUIT_BREAKER_HALF_OPEN_TIMEOUT_MS",
  "MAX_TOOLS_PER_CLIENT",
  "RATE_LIMIT_CLEANUP_INTERVAL_MS",
  "RATE_LIMIT_MAX_BUCKETS_GLOBAL",
  "RATE_LIMIT_MAX_BUCKETS_MCP",
  "RATE_LIMIT_MAX_BUCKETS_REGISTER",
  "SHUTDOWN_FORCE_EXIT_MS",
  "OTEL_MAX_BATCH",
  "OTEL_EXPORT_TIMEOUT_MS",
  "TRACE_RETENTION_MS",
  "CORS_MAX_AGE_SECONDS",
  "MAX_JSON_DEPTH",
  "VAULT_REQUEST_TIMEOUT_MS",
  "CONTEXT_BUDGET_LLM_TIMEOUT_MS",
  "USAGE_RETENTION_MS",
  "AUDIT_SINK_TIMEOUT_MS",
  "ALERT_INTERVAL_MS",
  "ALERT_WEBHOOK_TIMEOUT_MS",
  "ALERT_ERROR_RATE_WINDOW_MS",
  "ANOMALY_RECENT_WINDOW_MS",
  "ANOMALY_BASELINE_WINDOW_MS",
  "RATE_LIMIT_MAX_BUCKETS_TOOL",
  "SESSION_IDLE_TIMEOUT_MS",
  "SESSION_ABSOLUTE_TTL_MS",
  "RATE_LIMIT_LOGIN",
  "RATE_LIMIT_MAX_BUCKETS_LOGIN",
  "RATE_LIMIT_INSTALL_LINK",
  "RATE_LIMIT_MAX_BUCKETS_INSTALL_LINK",
  "LEADER_LEASE_DURATION_MS",
  "REGISTRY_SYNC_INTERVAL_MS",
  "ALLOW_PRIVATE_IPS",
  "AUTH_DISABLED",
  "TRAFFIC_CAPTURE",
  "TRACE_STORAGE",
  "CORS_ALLOW_CREDENTIALS",
  "AUTO_GATE_WRITE_METHODS",
  "ALLOW_UNSAFE_INSECURE_SESSION_COOKIE",
  "RATE_LIMIT_SHARED",
  "REGISTRY_SYNC",
  "METRICS_ENABLED",
  "ENABLE_SEARCH_TOOL",
  "SESSION_COOKIE_SECURE",
  "ALLOWED_HOSTS",
  "ALLOWED_ORIGINS",
  "ADMIN_API_KEYS",
  "MCP_API_KEYS",
  "APPROVAL_WEBHOOK_URL",
  "MONITOR_WEBHOOK_URL",
  "JWT_JWKS_URL",
  "JWT_ISSUER",
  "JWT_AUDIENCE",
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "SECRET_ENCRYPTION_KEY",
  "VAULT_ADDR",
  "VAULT_TOKEN",
  "AUDIT_SINK_URL",
  "GATEWAY_PUBLIC_URL",
  "BOOTSTRAP_ADMIN_USERNAME",
  "BOOTSTRAP_ADMIN_PASSWORD",
  "LOG_FORMAT",
  "DB_PATH",
  "VAULT_TRANSIT_KEY_NAME",
  "OTEL_SERVICE_NAME",
  "TRUST_PROXY",
  "SECRETS_PROVIDER",
  "CORS_ORIGINS",
  "INSTANCE_ID",
  "ALLOW_UNSAFE_CORS_WILDCARD",
] as const;

type ManagedEnvKey = (typeof MANAGED_ENV_KEYS)[number];
type AnyConfig = Record<string, unknown>;

/**
 * Imports config.ts as a brand-new module instance under an exact env
 * snapshot: every MANAGED_ENV_KEYS entry is first cleared, then `overrides`
 * is applied, so no ambient process.env state can leak into a scenario.
 * Restores the original process.env afterward regardless of success/failure
 * (module load can throw, e.g. an invalid SECRETS_PROVIDER).
 */
let importCounter = 0;
async function freshConfig(overrides: Partial<Record<ManagedEnvKey, string>>): Promise<AnyConfig> {
  const prev: Partial<Record<ManagedEnvKey, string | undefined>> = {};
  for (const key of MANAGED_ENV_KEYS) {
    prev[key] = process.env[key];
    const value = overrides[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  importCounter++;
  try {
    const mod = (await import(`../config.js?configmutationtest=${importCounter}`)) as { config: AnyConfig };
    return mod.config;
  } finally {
    for (const key of MANAGED_ENV_KEYS) {
      const original = prev[key];
      if (original === undefined) delete process.env[key];
      else process.env[key] = original;
    }
  }
}

// ─── Field tables ────────────────────────────────────────────────────────

interface NumericFieldSpec {
  configKey: string;
  envKey: ManagedEnvKey;
  def: number;
}

// `Number(process.env.X) || <literal default>` fields.
const NUMERIC_FIELDS: NumericFieldSpec[] = [
  { configKey: "port", envKey: "PORT", def: 3000 },
  { configKey: "toolCallTimeoutMs", envKey: "TOOL_CALL_TIMEOUT_MS", def: 30_000 },
  { configKey: "healthCheckTimeoutMs", envKey: "HEALTH_CHECK_TIMEOUT_MS", def: 5_000 },
  { configKey: "healthCheckIntervalMs", envKey: "HEALTH_CHECK_INTERVAL_MS", def: 30_000 },
  { configKey: "healthCheckMaxConcurrent", envKey: "HEALTH_CHECK_MAX_CONCURRENT", def: 20 },
  { configKey: "openapiDiscoveryTimeoutMs", envKey: "OPENAPI_DISCOVERY_TIMEOUT_MS", def: 10_000 },
  { configKey: "graphqlDiscoveryTimeoutMs", envKey: "GRAPHQL_DISCOVERY_TIMEOUT_MS", def: 10_000 },
  { configKey: "graphqlMaxTypes", envKey: "GRAPHQL_MAX_TYPES", def: 2_000 },
  { configKey: "graphqlSelectionMaxDepth", envKey: "GRAPHQL_SELECTION_MAX_DEPTH", def: 2 },
  { configKey: "graphqlInputMaxDepth", envKey: "GRAPHQL_INPUT_MAX_DEPTH", def: 3 },
  { configKey: "wsProxyMaxGlobalConnections", envKey: "WS_PROXY_MAX_GLOBAL_CONNECTIONS", def: 500 },
  { configKey: "wsProxyDefaultMaxConnectionsPerTarget", envKey: "WS_PROXY_DEFAULT_MAX_CONNECTIONS", def: 10 },
  { configKey: "wsProxyDefaultMaxMessageBytes", envKey: "WS_PROXY_DEFAULT_MAX_MESSAGE_BYTES", def: 1_048_576 },
  { configKey: "wsProxyDefaultIdleTimeoutMs", envKey: "WS_PROXY_DEFAULT_IDLE_TIMEOUT_MS", def: 300_000 },
  { configKey: "wsProxyDialTimeoutMs", envKey: "WS_PROXY_DIAL_TIMEOUT_MS", def: 10_000 },
  { configKey: "wsProxyRevalidateIntervalMs", envKey: "WS_PROXY_REVALIDATE_INTERVAL_MS", def: 60_000 },
  { configKey: "sessionTtlMs", envKey: "SESSION_TTL_MS", def: 1_800_000 },
  { configKey: "maxSessions", envKey: "MAX_SESSIONS", def: 100 },
  { configKey: "rateLimitRegister", envKey: "RATE_LIMIT_REGISTER", def: 10 },
  { configKey: "rateLimitMcp", envKey: "RATE_LIMIT_MCP", def: 100 },
  { configKey: "rateLimitGlobal", envKey: "RATE_LIMIT_GLOBAL", def: 1_000 },
  { configKey: "maxConsecutiveFailures", envKey: "MAX_CONSECUTIVE_FAILURES", def: 3 },
  { configKey: "maxResponseBytes", envKey: "MAX_RESPONSE_BYTES", def: 10_485_760 },
  { configKey: "retryAfterMaxMs", envKey: "RETRY_AFTER_MAX_MS", def: 30_000 },
  { configKey: "retryMaxAttempts", envKey: "RETRY_MAX_ATTEMPTS", def: 2 },
  { configKey: "retryBaseDelayMs", envKey: "RETRY_BASE_DELAY_MS", def: 500 },
  { configKey: "cacheMaxEntries", envKey: "CACHE_MAX_ENTRIES", def: 10_000 },
  { configKey: "lbTargetCooldownMs", envKey: "LB_TARGET_COOLDOWN_MS", def: 30_000 },
  { configKey: "approvalWebhookTimeoutMs", envKey: "APPROVAL_WEBHOOK_TIMEOUT_MS", def: 5_000 },
  { configKey: "trafficMaxBodyBytes", envKey: "TRAFFIC_MAX_BODY_BYTES", def: 8_192 },
  { configKey: "trafficRetentionMs", envKey: "TRAFFIC_RETENTION_MS", def: 604_800_000 },
  { configKey: "monitorWebhookTimeoutMs", envKey: "MONITOR_WEBHOOK_TIMEOUT_MS", def: 5_000 },
  { configKey: "jwtJwksCacheMs", envKey: "JWT_JWKS_CACHE_MS", def: 600_000 },
  { configKey: "jwtJwksTimeoutMs", envKey: "JWT_JWKS_TIMEOUT_MS", def: 5_000 },
  { configKey: "oauthTokenTimeoutMs", envKey: "OAUTH_TOKEN_TIMEOUT_MS", def: 10_000 },
  { configKey: "circuitBreakerWindowMs", envKey: "CIRCUIT_BREAKER_WINDOW_MS", def: 60_000 },
  { configKey: "circuitBreakerFailureThreshold", envKey: "CIRCUIT_BREAKER_FAILURE_THRESHOLD", def: 3 },
  { configKey: "circuitBreakerResetTimeoutMs", envKey: "CIRCUIT_BREAKER_RESET_TIMEOUT_MS", def: 30_000 },
  { configKey: "circuitBreakerHalfOpenTimeoutMs", envKey: "CIRCUIT_BREAKER_HALF_OPEN_TIMEOUT_MS", def: 5_000 },
  { configKey: "maxToolsPerClient", envKey: "MAX_TOOLS_PER_CLIENT", def: 100 },
  { configKey: "rateLimitCleanupIntervalMs", envKey: "RATE_LIMIT_CLEANUP_INTERVAL_MS", def: 300_000 },
  { configKey: "rateLimitMaxBucketsGlobal", envKey: "RATE_LIMIT_MAX_BUCKETS_GLOBAL", def: 50_000 },
  { configKey: "rateLimitMaxBucketsMcp", envKey: "RATE_LIMIT_MAX_BUCKETS_MCP", def: 100_000 },
  { configKey: "rateLimitMaxBucketsRegister", envKey: "RATE_LIMIT_MAX_BUCKETS_REGISTER", def: 10_000 },
  { configKey: "shutdownForceExitMs", envKey: "SHUTDOWN_FORCE_EXIT_MS", def: 10_000 },
  { configKey: "otelMaxBatch", envKey: "OTEL_MAX_BATCH", def: 128 },
  { configKey: "otelExportTimeoutMs", envKey: "OTEL_EXPORT_TIMEOUT_MS", def: 5_000 },
  { configKey: "traceRetentionMs", envKey: "TRACE_RETENTION_MS", def: 86_400_000 },
  { configKey: "corsMaxAgeSeconds", envKey: "CORS_MAX_AGE_SECONDS", def: 600 },
  { configKey: "maxJsonDepth", envKey: "MAX_JSON_DEPTH", def: 32 },
  { configKey: "vaultRequestTimeoutMs", envKey: "VAULT_REQUEST_TIMEOUT_MS", def: 5_000 },
  { configKey: "contextBudgetLlmTimeoutMs", envKey: "CONTEXT_BUDGET_LLM_TIMEOUT_MS", def: 15_000 },
  { configKey: "usageRetentionMs", envKey: "USAGE_RETENTION_MS", def: 2_592_000_000 },
  { configKey: "auditSinkTimeoutMs", envKey: "AUDIT_SINK_TIMEOUT_MS", def: 3_000 },
  { configKey: "alertIntervalMs", envKey: "ALERT_INTERVAL_MS", def: 30_000 },
  { configKey: "alertWebhookTimeoutMs", envKey: "ALERT_WEBHOOK_TIMEOUT_MS", def: 5_000 },
  { configKey: "alertErrorRateWindowMs", envKey: "ALERT_ERROR_RATE_WINDOW_MS", def: 300_000 },
  { configKey: "anomalyRecentWindowMs", envKey: "ANOMALY_RECENT_WINDOW_MS", def: 300_000 },
  { configKey: "anomalyBaselineWindowMs", envKey: "ANOMALY_BASELINE_WINDOW_MS", def: 3_600_000 },
  { configKey: "rateLimitMaxBucketsTool", envKey: "RATE_LIMIT_MAX_BUCKETS_TOOL", def: 20_000 },
  { configKey: "sessionIdleTimeoutMs", envKey: "SESSION_IDLE_TIMEOUT_MS", def: 1_800_000 },
  { configKey: "sessionAbsoluteTtlMs", envKey: "SESSION_ABSOLUTE_TTL_MS", def: 43_200_000 },
  { configKey: "rateLimitLogin", envKey: "RATE_LIMIT_LOGIN", def: 10 },
  { configKey: "rateLimitMaxBucketsLogin", envKey: "RATE_LIMIT_MAX_BUCKETS_LOGIN", def: 5_000 },
  { configKey: "rateLimitInstallLink", envKey: "RATE_LIMIT_INSTALL_LINK", def: 20 },
  { configKey: "rateLimitMaxBucketsInstallLink", envKey: "RATE_LIMIT_MAX_BUCKETS_INSTALL_LINK", def: 5_000 },
  { configKey: "leaderLeaseDurationMs", envKey: "LEADER_LEASE_DURATION_MS", def: 15_000 },
  { configKey: "registrySyncIntervalMs", envKey: "REGISTRY_SYNC_INTERVAL_MS", def: 15_000 },
];

interface FlagFieldSpec {
  configKey: string;
  envKey: ManagedEnvKey;
}

// `process.env.X === "true"` fields — default false, true only for the exact
// string "true".
const BOOL_TRUE_FIELDS: FlagFieldSpec[] = [
  { configKey: "allowPrivateIps", envKey: "ALLOW_PRIVATE_IPS" },
  { configKey: "authDisabled", envKey: "AUTH_DISABLED" },
  { configKey: "trafficCaptureEnabled", envKey: "TRAFFIC_CAPTURE" },
  { configKey: "traceStorageEnabled", envKey: "TRACE_STORAGE" },
  { configKey: "corsAllowCredentials", envKey: "CORS_ALLOW_CREDENTIALS" },
  { configKey: "autoGateWriteMethods", envKey: "AUTO_GATE_WRITE_METHODS" },
  { configKey: "allowUnsafeInsecureSessionCookie", envKey: "ALLOW_UNSAFE_INSECURE_SESSION_COOKIE" },
  { configKey: "rateLimitShared", envKey: "RATE_LIMIT_SHARED" },
  { configKey: "registrySyncEnabled", envKey: "REGISTRY_SYNC" },
];

// `process.env.X !== "false"` fields — default true (on by default), false
// only for the exact string "false".
const BOOL_FALSE_DETECT_FIELDS: FlagFieldSpec[] = [
  { configKey: "metricsEnabled", envKey: "METRICS_ENABLED" },
  { configKey: "enableSearchTool", envKey: "ENABLE_SEARCH_TOOL" },
  { configKey: "sessionCookieSecure", envKey: "SESSION_COOKIE_SECURE" },
];

interface ArrayFieldSpec {
  configKey: string;
  envKey: ManagedEnvKey;
  def: string[];
  overrideRaw: string;
  overrideExpected: string[];
}

// `process.env.X?.split(",").map(trim).filter(Boolean) ?? <default array>`
// fields. overrideRaw deliberately has leading/trailing whitespace and stray
// commas so a single scenario exercises trimming and empty-entry dropping,
// and each field gets >= 2 distinct kept entries so a "collapsed to 1"
// mutant is distinguishable from correct behavior.
const ARRAY_FIELDS: ArrayFieldSpec[] = [
  {
    configKey: "allowedHosts",
    envKey: "ALLOWED_HOSTS",
    def: [],
    overrideRaw: " host1.example.com , , host2.example.com ,",
    overrideExpected: ["host1.example.com", "host2.example.com"],
  },
  {
    configKey: "allowedOrigins",
    envKey: "ALLOWED_ORIGINS",
    def: ["http://localhost:*"],
    overrideRaw: " http://o1.example.com , , http://o2.example.com ,",
    overrideExpected: ["http://o1.example.com", "http://o2.example.com"],
  },
  {
    configKey: "adminApiKeys",
    envKey: "ADMIN_API_KEYS",
    def: [],
    overrideRaw: " key-admin-1 , , key-admin-2 ,",
    overrideExpected: ["key-admin-1", "key-admin-2"],
  },
  {
    configKey: "mcpApiKeys",
    envKey: "MCP_API_KEYS",
    def: [],
    overrideRaw: " key-mcp-1 , , key-mcp-2 ,",
    overrideExpected: ["key-mcp-1", "key-mcp-2"],
  },
];

interface OptionalStringFieldSpec {
  configKey: string;
  envKey: ManagedEnvKey;
  overrideValue: string;
}

// `process.env.X || undefined` fields — default undefined.
const OPTIONAL_STRING_FIELDS: OptionalStringFieldSpec[] = [
  {
    configKey: "approvalWebhookUrl",
    envKey: "APPROVAL_WEBHOOK_URL",
    overrideValue: "https://hooks.example.com/approval",
  },
  { configKey: "monitorWebhookUrl", envKey: "MONITOR_WEBHOOK_URL", overrideValue: "https://hooks.example.com/monitor" },
  {
    configKey: "jwtJwksUrl",
    envKey: "JWT_JWKS_URL",
    overrideValue: "https://issuer.example.com/.well-known/jwks.json",
  },
  { configKey: "jwtIssuer", envKey: "JWT_ISSUER", overrideValue: "https://issuer.example.com/" },
  { configKey: "jwtAudience", envKey: "JWT_AUDIENCE", overrideValue: "unit-test-audience" },
  {
    configKey: "otelEndpoint",
    envKey: "OTEL_EXPORTER_OTLP_ENDPOINT",
    overrideValue: "http://collector.example.com:4318/v1/traces",
  },
  {
    configKey: "secretEncryptionKey",
    envKey: "SECRET_ENCRYPTION_KEY",
    overrideValue: "unit-test-secret-encryption-key",
  },
  { configKey: "vaultAddr", envKey: "VAULT_ADDR", overrideValue: "https://vault.example.com:8200" },
  { configKey: "vaultToken", envKey: "VAULT_TOKEN", overrideValue: "unit-test-vault-token" },
  { configKey: "auditSinkUrl", envKey: "AUDIT_SINK_URL", overrideValue: "https://siem.example.com/audit" },
  { configKey: "gatewayPublicUrl", envKey: "GATEWAY_PUBLIC_URL", overrideValue: "https://gateway.example.com" },
  { configKey: "bootstrapAdminUsername", envKey: "BOOTSTRAP_ADMIN_USERNAME", overrideValue: "unit-test-admin" },
  { configKey: "bootstrapAdminPassword", envKey: "BOOTSTRAP_ADMIN_PASSWORD", overrideValue: "unit-test-password" },
];

interface LiteralStringFieldSpec {
  configKey: string;
  envKey: ManagedEnvKey;
  def: string;
  overrideValue: string;
}

// `process.env.X || "<literal>"` fields — default a non-empty literal
// string (not undefined).
const LITERAL_STRING_FIELDS: LiteralStringFieldSpec[] = [
  { configKey: "logFormat", envKey: "LOG_FORMAT", def: "json", overrideValue: "text" },
  {
    configKey: "dbPath",
    envKey: "DB_PATH",
    def: "./data/mcp-bridge.db",
    overrideValue: "/tmp/unit-test-mcp-bridge.db",
  },
  {
    configKey: "vaultTransitKeyName",
    envKey: "VAULT_TRANSIT_KEY_NAME",
    def: "mcp-rest-bridge",
    overrideValue: "unit-test-transit-key",
  },
  {
    configKey: "otelServiceName",
    envKey: "OTEL_SERVICE_NAME",
    def: "mcp-rest-bridge",
    overrideValue: "unit-test-service",
  },
];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function buildFullOverrides(): Partial<Record<ManagedEnvKey, string>> {
  const overrides: Partial<Record<ManagedEnvKey, string>> = {};
  for (const f of NUMERIC_FIELDS) overrides[f.envKey] = String(f.def + 1);
  for (const f of BOOL_TRUE_FIELDS) overrides[f.envKey] = "true";
  for (const f of BOOL_FALSE_DETECT_FIELDS) overrides[f.envKey] = "false";
  for (const f of ARRAY_FIELDS) overrides[f.envKey] = f.overrideRaw;
  for (const f of OPTIONAL_STRING_FIELDS) overrides[f.envKey] = f.overrideValue;
  for (const f of LITERAL_STRING_FIELDS) overrides[f.envKey] = f.overrideValue;
  overrides.TRUST_PROXY = "7";
  overrides.SECRETS_PROVIDER = "vault";
  overrides.CORS_ORIGINS = "https://cors-override.example.com";
  overrides.INSTANCE_ID = "unit-test-fixed-instance-id";
  return overrides;
}

// An explicit empty string is the one input class where `||` and `??`
// genuinely diverge (falsy AND non-nullish): `"" || y` yields `y`, but
// `"" ?? y` yields `""`. This scenario sets every optional/literal-default
// string field (and INSTANCE_ID) to "" so any `||`-to-`??` mutant on those
// lines is observable.
function buildEmptyStringOverrides(): Partial<Record<ManagedEnvKey, string>> {
  const overrides: Partial<Record<ManagedEnvKey, string>> = {};
  for (const f of OPTIONAL_STRING_FIELDS) overrides[f.envKey] = "";
  for (const f of LITERAL_STRING_FIELDS) overrides[f.envKey] = "";
  overrides.INSTANCE_ID = "";
  return overrides;
}

let defaultsCfg: AnyConfig;
let overriddenCfg: AnyConfig;
let emptyStringCfg: AnyConfig;
let instanceIdSecondSampleCfg: AnyConfig;

beforeAll(async () => {
  defaultsCfg = await freshConfig({});
  overriddenCfg = await freshConfig(buildFullOverrides());
  emptyStringCfg = await freshConfig(buildEmptyStringOverrides());
  instanceIdSecondSampleCfg = await freshConfig({});
});

// ─── Numeric fields ─────────────────────────────────────────────────────────

describe("config — numeric env-driven fields (Number(env) || default)", () => {
  test("fall back to their documented default when the env var is unset", () => {
    for (const f of NUMERIC_FIELDS) {
      expect(defaultsCfg[f.configKey]).toBe(f.def);
    }
  });

  test("use the env var's numeric value (not the default) when set", () => {
    for (const f of NUMERIC_FIELDS) {
      expect(overriddenCfg[f.configKey]).toBe(f.def + 1);
    }
  });
});

// ─── `=== "true"` boolean fields ────────────────────────────────────────────

describe('config — `=== "true"` boolean fields (default-off)', () => {
  test("default to false when unset", () => {
    for (const f of BOOL_TRUE_FIELDS) {
      expect(defaultsCfg[f.configKey]).toBe(false);
    }
  });

  test("are true only for the exact string 'true'", () => {
    for (const f of BOOL_TRUE_FIELDS) {
      expect(overriddenCfg[f.configKey]).toBe(true);
    }
  });
});

// ─── `!== "false"` boolean fields ───────────────────────────────────────────

describe('config — `!== "false"` boolean fields (default-on)', () => {
  test("default to true when unset", () => {
    for (const f of BOOL_FALSE_DETECT_FIELDS) {
      expect(defaultsCfg[f.configKey]).toBe(true);
    }
  });

  test("flip to false only for the exact string 'false'", () => {
    for (const f of BOOL_FALSE_DETECT_FIELDS) {
      expect(overriddenCfg[f.configKey]).toBe(false);
    }
  });
});

// ─── CSV array fields ───────────────────────────────────────────────────────

describe("config — CSV array fields (split/trim/filter ?? default)", () => {
  test("default to the documented empty/seed array when unset", () => {
    for (const f of ARRAY_FIELDS) {
      expect(defaultsCfg[f.configKey]).toEqual(f.def);
    }
  });

  test("split on comma, trim whitespace, and drop empty entries when set", () => {
    for (const f of ARRAY_FIELDS) {
      expect(overriddenCfg[f.configKey]).toEqual(f.overrideExpected);
    }
  });
});

// ─── Optional string fields (|| undefined) ─────────────────────────────────

describe("config — optional string fields (`|| undefined`)", () => {
  test("default to undefined when unset", () => {
    for (const f of OPTIONAL_STRING_FIELDS) {
      expect(defaultsCfg[f.configKey]).toBeUndefined();
    }
  });

  test("take the env var's value verbatim when set", () => {
    for (const f of OPTIONAL_STRING_FIELDS) {
      expect(overriddenCfg[f.configKey]).toBe(f.overrideValue);
    }
  });

  test("an explicit empty string still falls back to undefined (proves `||`, not `??`)", () => {
    for (const f of OPTIONAL_STRING_FIELDS) {
      expect(emptyStringCfg[f.configKey]).toBeUndefined();
    }
  });
});

// ─── Literal-default string fields (|| "literal") ──────────────────────────

describe('config — literal-default string fields (`|| "literal"`)', () => {
  test("default to their documented literal when unset", () => {
    for (const f of LITERAL_STRING_FIELDS) {
      expect(defaultsCfg[f.configKey]).toBe(f.def);
    }
  });

  test("take the env var's value when set", () => {
    for (const f of LITERAL_STRING_FIELDS) {
      expect(overriddenCfg[f.configKey]).toBe(f.overrideValue);
    }
  });

  test("an explicit empty string still falls back to the literal default (proves `||`, not `??`)", () => {
    for (const f of LITERAL_STRING_FIELDS) {
      expect(emptyStringCfg[f.configKey]).toBe(f.def);
    }
  });
});

// ─── trustProxy / secretsProvider / corsOrigins wiring ─────────────────────
//
// The full branch logic of parseTrustProxy/parseSecretsProvider/
// parseCorsOrigins is already exhaustively covered in config-parsers.test.ts.
// These only confirm config.ts actually WIRES each helper's result onto the
// `config` object (a mutant swapping in a different value/property here
// wouldn't be caught by that sibling file, which calls the helpers directly
// rather than reading them off `config`).

describe("config — trustProxy / secretsProvider / corsOrigins wiring", () => {
  test("config.trustProxy reflects parseTrustProxy()'s result", () => {
    expect(defaultsCfg.trustProxy).toBe(false);
    expect(overriddenCfg.trustProxy).toBe(7);
  });

  test("config.secretsProvider reflects parseSecretsProvider()'s result", () => {
    expect(defaultsCfg.secretsProvider).toBe("local");
    expect(overriddenCfg.secretsProvider).toBe("vault");
  });

  test("config.corsOrigins reflects the module-level parseCorsOrigins() call", () => {
    expect(defaultsCfg.corsOrigins).toEqual([]);
    expect(overriddenCfg.corsOrigins).toEqual(["https://cors-override.example.com"]);
  });
});

// ─── instanceId ─────────────────────────────────────────────────────────────

describe("config — instanceId (`process.env.INSTANCE_ID || crypto.randomUUID()`)", () => {
  test("defaults to a freshly generated UUID, not a fixed string", () => {
    expect(typeof defaultsCfg.instanceId).toBe("string");
    expect(defaultsCfg.instanceId as string).toMatch(UUID_RE);
    // A second, independent default import must produce a DIFFERENT id --
    // proves the field really calls crypto.randomUUID() at each module
    // load rather than returning a hard-coded/memoized string.
    expect(instanceIdSecondSampleCfg.instanceId).not.toBe(defaultsCfg.instanceId);
  });

  test("INSTANCE_ID overrides the generated UUID when set", () => {
    expect(overriddenCfg.instanceId).toBe("unit-test-fixed-instance-id");
  });

  test("an explicit empty INSTANCE_ID still falls back to a generated UUID (proves `||`, not `??`)", () => {
    expect(typeof emptyStringCfg.instanceId).toBe("string");
    expect(emptyStringCfg.instanceId as string).toMatch(UUID_RE);
  });
});

// ─── parseCorsOrigins gap-fills ─────────────────────────────────────────────
//
// config-parsers.test.ts covers parseCorsOrigins's branch logic exhaustively,
// but its `.toThrow(/wildcard/i)` / `.toThrow(/Invalid CORS origin/)`
// assertions are satisfied by EITHER half of each two-part concatenated
// error message (both halves happen to independently contain "wildcard" /
// "Invalid CORS origin" — the wildcard message has "wildcard" in its first
// half and "WILDCARD" inside `ALLOW_UNSAFE_CORS_WILDCARD` in its second;
// "Invalid CORS origin" is entirely in the first half of that message), so a
// mutant that nukes just one half's string literal isn't caught. These add
// precise, half-specific assertions instead. Also covers the one real gap
// found in `normaliseOrigin`/`parseCorsOrigins`'s otherwise-redundant-looking
// trim calls: a padded `"*"` entry only round-trips to wildcard mode because
// `parseCorsOrigins` trims each entry BEFORE the exact `entries.includes("*")`
// check (normaliseOrigin's own internal trim happens too late to save it --
// `new URL("*")` would throw).

describe("config — parseCorsOrigins gap-fills (precise error text + wildcard trim)", () => {
  test("a whitespace-padded '*' entry still resolves to wildcard mode", () => {
    expect(parseCorsOrigins(" * ", true)).toEqual(["*"]);
  });

  test("the wildcard-forbidden error names the wildcard clause specifically (first half)", () => {
    expect(() => parseCorsOrigins("*", false)).toThrow(/CORS wildcard '\*' is forbidden when auth is enabled\./);
  });

  test("the wildcard-forbidden error also names the escape hatch specifically (second half)", () => {
    expect(() => parseCorsOrigins("*", false)).toThrow(/Set ALLOW_UNSAFE_CORS_WILDCARD=true to override/);
  });

  test("the invalid-origin error also names the accepted shape specifically (second half)", () => {
    expect(() => parseCorsOrigins("not a url", false)).toThrow(
      /Each entry must be a valid http:\/\/ or https:\/\/ URL with no path, query, or fragment\./,
    );
  });
});

// ─── CORS constants (not env-driven) ───────────────────────────────────────

describe("config — CORS constants", () => {
  test("corsAllowedMethods", () => {
    expect(defaultsCfg.corsAllowedMethods).toEqual(["GET", "POST", "DELETE", "OPTIONS"]);
  });

  test("corsAllowedHeaders", () => {
    expect(defaultsCfg.corsAllowedHeaders).toEqual([
      "Content-Type",
      "Authorization",
      "Mcp-Session-Id",
      "X-Request-Id",
      "X-CSRF-Token",
    ]);
  });

  test("corsExposedHeaders", () => {
    expect(defaultsCfg.corsExposedHeaders).toEqual(["Mcp-Session-Id", "X-Request-Id"]);
  });
});
