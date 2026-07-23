/**
 * Typed env validation — surfaces unknown env vars and value-level mistakes
 * (typos, out-of-range, wrong types) at boot, without changing the shape of
 * `config` in `src/config.ts`. This is the source of truth for "what env vars
 * does the bridge read?" — `config.ts` parses them; `config-schema.ts` validates
 * the raw `process.env`. Two views of the same contract: one runs (config.ts),
 * the other checks (this file).
 *
 * Design constraint: `validateEnv()` MUST NOT exit the process or throw on
 * validation failure. The bridge has `checkStartupGuards` for hard runtime
 * invariants (auth, cors wildcard, trust-proxy, secure cookie) and exits there.
 * This module's job is to log a clear, actionable warning naming every bad env
 * var so an operator can fix them. Tests cover both the warn-only contract and
 * the schema itself.
 *
 * `STRICT_CONFIG=production` upgrades warnings to errors via `validateEnvStrict`
 * for CI / production boot; the default `validateEnv` keeps dev unaffected.
 */
import { z } from "zod";
import { log } from "./logger.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Boolean coerced env — accepts exactly "true" / "false" (case-sensitive) and
 * rejects anything else (including "1", "0", "yes"). Matches the hard-coded
 * `=== "true"` checks the codebase uses everywhere.
 */
const envBool = z.union([z.literal("true"), z.literal("false"), z.undefined()]).transform((v) => v === "true");

/**
 * Same accepted values as envBool, but for the handful of config.ts fields
 * that default to `true` when unset (the `!== "false"` idiom — anything other
 * than the literal string "false" leaves the feature on). Keeps this schema's
 * parsed default in agreement with config.ts's actual runtime default for
 * those fields; using plain envBool for them would silently disagree (both
 * "unset" and "false" would parse to `false` here, even though unset means
 * `true` at runtime).
 */
const envBoolDefaultTrue = z
  .union([z.literal("true"), z.literal("false"), z.undefined()])
  .transform((v) => v !== "false");

/** Non-negative integer in [min, max], with a default. */
const envInt = (def: number, min: number, max: number) =>
  z.union([z.string(), z.undefined()]).transform((raw, ctx) => {
    if (raw === undefined || raw === "") return def;
    const n = Number(raw);
    if (!Number.isFinite(n) || !Number.isInteger(n)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `expected integer, got ${JSON.stringify(raw)}` });
      return z.NEVER;
    }
    if (n < min || n > max) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `expected integer in [${min}, ${max}], got ${n}`,
      });
      return z.NEVER;
    }
    return n;
  });

/** CSV of trimmed, non-empty strings. */
const envCsv = z.union([z.string(), z.undefined()]).transform((raw) =>
  raw
    ? raw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : [],
);

/** Optional URL — must parse with the WHATWG URL parser. */
const envUrl = z.union([z.string(), z.undefined()]).transform((raw, ctx) => {
  if (!raw) return undefined;
  try {
    new URL(raw);
    return raw;
  } catch {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `expected URL, got ${JSON.stringify(raw)}` });
    return z.NEVER;
  }
});

/** Optional trimmed string. */
const envOptString = z.union([z.string(), z.undefined()]).transform((raw) => raw?.trim() || undefined);

/** Two-valued enum coerced into a literal union. */
function envEnum<T extends readonly [string, ...string[]]>(values: T, def?: T[number]) {
  return z.union([z.string(), z.undefined()]).transform((raw, ctx) => {
    if (raw === undefined || raw === "") return def;
    if (!(values as readonly string[]).includes(raw)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `expected one of ${values.join(", ")}, got ${JSON.stringify(raw)}`,
      });
      return z.NEVER;
    }
    return raw as T[number];
  });
}

// ─── Schema ──────────────────────────────────────────────────────────────────

/**
 * The full set of env vars the bridge reads. Keys MUST match the `process.env.*`
 * reads performed by config.ts (and the few out-of-band reads in startup-guards,
 * jwt, vault, otel, etc.). Adding a new env var here is enforced by reviewers;
 * if it isn't here, `validateEnv` flags it as unknown.
 *
 * Unknown-env detection strategy: every key in `process.env` that maps to a
 * recognised MCP_REST_BRIDGE_* / SECRETS_* / VAULT_* / OTEL_* / JWT_* / OIDC_*
 * / CORS_* / SESSION_* / AUTH_* / ADMIN_* / BOOTSTRAP_* / ALLOW_* / LOG_*
 * / METRICS_* / NODE_ENV / PORT / INSTANCE_ID / LEADER_* / RATE_LIMIT_*
 * / CIRCUIT_BREAKER_* / TOOL_CALL_* / HEALTH_CHECK_* / OPENAPI_*
 * / GRAPHQL_* / RETRY_* / CACHE_* / LB_* / WS_PROXY_* / DB_PATH
 * / TRAFFIC_* / MONITOR_* / APPROVAL_* / ANOMALY_* / USAGE_*
 * / AUDIT_SINK_* / ALERT_* / PROXY_* / ENABLE_* / GATEWAY_*
 * / REGISTRY_* / SHUTDOWN_* / TRACE_* / MAX_* / CONTEXT_BUDGET_*
 * prefix is allowed in `process.env` but the schema reports every key in
 * `process.env` whose normalised name doesn't match a schema key as `unknown`.
 *
 * To keep this practical, only the values the schema actually validates matter
 * here — anything beyond the listed keys is reported as unknown so a typo'd
 * `TOOL_CALL_TIMEOUTMS` would still be flagged (we'd never match it).
 */
const EnvSchema = z.object({
  // ── Server / runtime ─────────────────────────────────────────────────────
  PORT: envInt(3000, 1, 65535),
  NODE_ENV: z.union([z.string(), z.undefined()]).transform((v) => v ?? "development"),
  // Set to "production" to make validateEnvStrict abort boot on any env
  // validation error, instead of only logging warnings (the dev-ergonomic
  // default). Any other value leaves the warn-only behavior in place.
  STRICT_CONFIG: envOptString,

  // ── Auth & session ────────────────────────────────────────────────────────
  AUTH_DISABLED: envBool,
  REQUIRE_MCP_AUTH: envBool,
  EXPOSE_DOCS_UNAUTHENTICATED: envBool,
  ADMIN_API_KEYS: envCsv,
  MCP_API_KEYS: envCsv,
  SESSION_TTL_MS: envInt(1_800_000, 60_000, 86_400_000),
  MAX_SESSIONS: envInt(100, 1, 100_000),
  SESSION_IDLE_TIMEOUT_MS: envInt(30 * 60_000, 60_000, 86_400_000),
  SESSION_ABSOLUTE_TTL_MS: envInt(12 * 60 * 60_000, 300_000, 30 * 86_400_000),
  SESSION_COOKIE_SECURE: envBoolDefaultTrue,
  ALLOW_UNSAFE_INSECURE_SESSION_COOKIE: envBool,
  ALLOW_UNSAFE_AUTH_DISABLED: envBool,
  ALLOW_UNSAFE_JWT_NO_AUDIENCE: envBool,
  BOOTSTRAP_ADMIN_USERNAME: envOptString,
  BOOTSTRAP_ADMIN_PASSWORD: envOptString,

  // ── Network / CORS / proxy ────────────────────────────────────────────────
  ALLOW_PRIVATE_IPS: envBool,
  ALLOWED_HOSTS: envCsv,
  ALLOWED_ORIGINS: envCsv,
  CORS_ORIGINS: envOptString,
  ALLOW_UNSAFE_CORS_WILDCARD: envBool,
  CORS_ALLOW_CREDENTIALS: envBool,
  CORS_MAX_AGE_SECONDS: envInt(600, 0, 86_400),
  TRUST_PROXY: envOptString,

  // ── Timeouts / rate limits ───────────────────────────────────────────────
  TOOL_CALL_TIMEOUT_MS: envInt(30_000, 100, 600_000),
  HEALTH_CHECK_TIMEOUT_MS: envInt(5_000, 100, 60_000),
  HEALTH_CHECK_INTERVAL_MS: envInt(30_000, 100, 86_400_000),
  HEALTH_CHECK_MAX_CONCURRENT: envInt(20, 1, 1_000),
  OPENAPI_DISCOVERY_TIMEOUT_MS: envInt(10_000, 100, 120_000),
  GRAPHQL_DISCOVERY_TIMEOUT_MS: envInt(10_000, 100, 120_000),
  RATE_LIMIT_REGISTER: envInt(10, 1, 100_000),
  RATE_LIMIT_MCP: envInt(100, 1, 100_000),
  RATE_LIMIT_GLOBAL: envInt(1_000, 1, 1_000_000),
  RATE_LIMIT_LOGIN: envInt(10, 1, 100_000),
  RATE_LIMIT_INSTALL_LINK: envInt(20, 1, 100_000),
  RATE_LIMIT_BACKUP: envInt(5, 1, 100_000),
  RATE_LIMIT_SSO: envInt(20, 1, 100_000),
  RATE_LIMIT_EXPENSIVE: envInt(10, 1, 100_000),
  RATE_LIMIT_MAX_BUCKETS_GLOBAL: envInt(50_000, 1, 10_000_000),
  RATE_LIMIT_MAX_BUCKETS_MCP: envInt(100_000, 1, 10_000_000),
  RATE_LIMIT_MAX_BUCKETS_REGISTER: envInt(10_000, 1, 10_000_000),
  RATE_LIMIT_MAX_BUCKETS_LOGIN: envInt(5_000, 1, 1_000_000),
  RATE_LIMIT_MAX_BUCKETS_INSTALL_LINK: envInt(5_000, 1, 1_000_000),
  RATE_LIMIT_MAX_BUCKETS_BACKUP: envInt(1_000, 1, 1_000_000),
  RATE_LIMIT_MAX_BUCKETS_SSO: envInt(5_000, 1, 1_000_000),
  RATE_LIMIT_MAX_BUCKETS_EXPENSIVE: envInt(5_000, 1, 1_000_000),
  RATE_LIMIT_MAX_BUCKETS_TOOL: envInt(20_000, 1, 10_000_000),
  RATE_LIMIT_CLEANUP_INTERVAL_MS: envInt(300_000, 1_000, 86_400_000),
  RATE_LIMIT_SHARED: envBool,

  // ── Limits / caps ─────────────────────────────────────────────────────────
  MAX_RESPONSE_BYTES: envInt(10_485_760, 1_024, 1_073_741_824),
  MAX_TOOLS_PER_CLIENT: envInt(100, 1, 10_000),
  MAX_CONSECUTIVE_FAILURES: envInt(3, 1, 100),
  MAX_JSON_DEPTH: envInt(32, 1, 1_000),
  GRAPHQL_MAX_TYPES: envInt(2_000, 10, 100_000),
  GRAPHQL_SELECTION_MAX_DEPTH: envInt(2, 1, 32),
  GRAPHQL_INPUT_MAX_DEPTH: envInt(3, 1, 32),
  RETRY_MAX_ATTEMPTS: envInt(2, 0, 10),
  RETRY_BASE_DELAY_MS: envInt(500, 0, 60_000),
  RETRY_AFTER_MAX_MS: envInt(30_000, 0, 600_000),
  CACHE_MAX_ENTRIES: envInt(10_000, 0, 1_000_000),
  LB_TARGET_COOLDOWN_MS: envInt(30_000, 0, 600_000),
  WS_PROXY_MAX_GLOBAL_CONNECTIONS: envInt(500, 1, 100_000),
  WS_PROXY_DEFAULT_MAX_CONNECTIONS: envInt(10, 1, 10_000),
  WS_PROXY_DEFAULT_MAX_MESSAGE_BYTES: envInt(1_048_576, 1_024, 1_073_741_824),
  WS_PROXY_DEFAULT_IDLE_TIMEOUT_MS: envInt(300_000, 1_000, 86_400_000),
  WS_PROXY_DIAL_TIMEOUT_MS: envInt(10_000, 100, 120_000),
  WS_PROXY_REVALIDATE_INTERVAL_MS: envInt(60_000, 1_000, 86_400_000),

  // ── Resilience ────────────────────────────────────────────────────────────
  CIRCUIT_BREAKER_WINDOW_MS: envInt(60_000, 1_000, 86_400_000),
  CIRCUIT_BREAKER_FAILURE_THRESHOLD: envInt(3, 1, 1_000),
  CIRCUIT_BREAKER_RESET_TIMEOUT_MS: envInt(30_000, 0, 3_600_000),
  CIRCUIT_BREAKER_HALF_OPEN_TIMEOUT_MS: envInt(5_000, 100, 300_000),
  SHUTDOWN_FORCE_EXIT_MS: envInt(10_000, 100, 600_000),
  LEADER_LEASE_DURATION_MS: envInt(15_000, 1_000, 600_000),
  INSTANCE_ID: envOptString,
  REGISTRY_SYNC: envBool,
  REGISTRY_SYNC_INTERVAL_MS: envInt(15_000, 1_000, 86_400_000),

  // ── Tool guards ──────────────────────────────────────────────────────────
  AUTO_GATE_WRITE_METHODS: envBool,
  ENABLE_SEARCH_TOOL: envBoolDefaultTrue,
  GATEWAY_PUBLIC_URL: envUrl,

  // ── Context budget / LLM ─────────────────────────────────────────────────
  CONTEXT_BUDGET_LLM_TIMEOUT_MS: envInt(15_000, 100, 300_000),

  // ── Observability ────────────────────────────────────────────────────────
  METRICS_ENABLED: envBoolDefaultTrue,
  LOG_FORMAT: envEnum(["json", "text"] as const, "json"),
  OTEL_EXPORTER_OTLP_ENDPOINT: envUrl,
  OTEL_SERVICE_NAME: z.union([z.string(), z.undefined()]).transform((v) => v ?? "mcp-rest-bridge"),
  OTEL_MAX_BATCH: envInt(128, 1, 10_000),
  OTEL_EXPORT_TIMEOUT_MS: envInt(5_000, 100, 120_000),
  TRACE_STORAGE: envBool,
  TRACE_RETENTION_MS: envInt(24 * 60 * 60_000, 60_000, 30 * 86_400_000),
  TRAFFIC_CAPTURE: envBool,
  TRAFFIC_MAX_BODY_BYTES: envInt(8_192, 0, 1_073_741_824),
  TRAFFIC_RETENTION_MS: envInt(7 * 86_400_000, 60_000, 365 * 86_400_000),
  APPROVAL_WEBHOOK_URL: envUrl,
  APPROVAL_WEBHOOK_TIMEOUT_MS: envInt(5_000, 100, 120_000),
  MONITOR_WEBHOOK_URL: envUrl,
  MONITOR_WEBHOOK_TIMEOUT_MS: envInt(5_000, 100, 120_000),
  AUDIT_SINK_URL: envUrl,
  AUDIT_SINK_TIMEOUT_MS: envInt(3_000, 100, 120_000),
  ALERT_INTERVAL_MS: envInt(30_000, 1_000, 86_400_000),
  ALERT_WEBHOOK_TIMEOUT_MS: envInt(5_000, 100, 120_000),
  ALERT_ERROR_RATE_WINDOW_MS: envInt(5 * 60_000, 60_000, 86_400_000),
  ANOMALY_RECENT_WINDOW_MS: envInt(5 * 60_000, 60_000, 86_400_000),
  ANOMALY_BASELINE_WINDOW_MS: envInt(60 * 60_000, 60_000, 30 * 86_400_000),
  USAGE_RETENTION_MS: envInt(30 * 86_400_000, 60_000, 365 * 86_400_000),

  // ── JWT / OIDC ────────────────────────────────────────────────────────────
  JWT_JWKS_URL: envUrl,
  JWT_ISSUER: envOptString,
  JWT_AUDIENCE: envOptString,
  JWT_JWKS_CACHE_MS: envInt(600_000, 0, 86_400_000),
  JWT_JWKS_TIMEOUT_MS: envInt(5_000, 100, 120_000),
  OAUTH_TOKEN_TIMEOUT_MS: envInt(10_000, 100, 120_000),

  // ── Secrets / vault ───────────────────────────────────────────────────────
  SECRET_ENCRYPTION_KEY: envOptString,
  SECRETS_PROVIDER: envEnum(["local", "vault"] as const, "local"),
  VAULT_ADDR: envUrl,
  VAULT_TOKEN: envOptString,
  VAULT_TRANSIT_KEY_NAME: z.union([z.string(), z.undefined()]).transform((v) => v ?? "mcp-rest-bridge"),
  VAULT_REQUEST_TIMEOUT_MS: envInt(5_000, 100, 120_000),

  // ── Persistence ───────────────────────────────────────────────────────────
  DB_PATH: z.union([z.string(), z.undefined()]).transform((v) => v ?? "./data/mcp-bridge.db"),
});

/**
 * Every env-var name this schema validates. Test-only accessor (hence the
 * `__*ForTesting` name — it is not part of the module's production surface):
 * the config.ts↔schema parity test asserts that every `process.env.*` read in
 * config.ts has a matching schema entry — a read with no schema key would be
 * mis-reported as an "unknown env var" by validateEnv (see the schema docblock
 * above). Locks in the "reviewers enforce it" convention as an automated check.
 */
export const __envSchemaKeysForTesting: readonly string[] = Object.keys(EnvSchema.shape);

// ─── Run output ──────────────────────────────────────────────────────────────

export interface EnvIssue {
  /** Either "unknown" (env var present in process but not in schema), or a path into EnvSchema (e.g. "PORT"). */
  key: string;
  message: string;
}

export interface EnvReport {
  ok: boolean;
  /** Schema-level failures: missing required values, type errors, out-of-range. */
  errors: EnvIssue[];
  /** Process-level anomalies: env vars present in process.env that aren't part of the schema. */
  unknown: EnvIssue[];
}

/**
 * Validates env against the schema. Never throws. Returns a structured report.
 *
 * The "unknown" detector compares every key in `process.env` against the
 * schema's keys — typo'd variables (e.g. `TOOL_CALL_TIMEOUTMS`) show up here.
 *
 * NOTE: this is a sanity check, not a strict whitelist. Most operators WILL
 * have other env vars present (PATH, NODE_OPTIONS, npm_*). We only flag
 * "looks-like-an-MCP-bridge-variable" names to keep signal high. The detector
 * is permissive: it flags unknowns but the report is still `ok` unless a
 * schema field fails validation.
 */
export function validateEnv(env: NodeJS.ProcessEnv = process.env): EnvReport {
  const result = EnvSchema.safeParse(env);
  const errors: EnvIssue[] = [];

  if (!result.success) {
    for (const issue of result.error.issues) {
      const key = String(issue.path[0] ?? "<root>");
      errors.push({ key, message: issue.message });
    }
  }

  // Unknown-env detection. Only consider names that look like ours (uppercase
  // snake-case starting with a known prefix) so PATH, npm_*, etc. don't fire.
  const allowed = new Set(Object.keys(EnvSchema.shape));
  const prefixes = [
    "MCP_",
    "AUTH_",
    "ADMIN_",
    "CORS_",
    "CACHE_",
    "SECRETS_",
    "VAULT_",
    "JWT_",
    "OAUTH_",
    "OTEL_",
    "TRACE_",
    "TRAFFIC_",
    "AUDIT_",
    "ALERT_",
    "ANOMALY_",
    "ALLOW_",
    "RATE_LIMIT_",
    "CIRCUIT_BREAKER_",
    "RETENTION",
    "CONTEXT_BUDGET_",
    "LEADER_",
    "REGISTRY_",
    "SHUTDOWN_",
    "GRAPHQL_",
    "OPENAPI_",
    "HEALTH_CHECK_",
    "TOOL_CALL_",
    "USAGE_",
    "WS_PROXY_",
    "LB_",
    "MAX_",
    "MIN_",
    "INSTANCE_",
    "GATEWAY_",
    "SESSION_",
    "RETRY_",
    "LOG_",
    "METRICS_",
    "MONITOR_",
    "APPROVAL_",
    "AUTO_",
    "ENABLE_",
    "BOOTSTRAP_",
    "HSTS_",
    "PROXY_",
  ];
  const unknown: EnvIssue[] = [];
  for (const k of Object.keys(env)) {
    if (allowed.has(k)) continue;
    if (!prefixes.some((p) => k.startsWith(p))) continue;
    unknown.push({ key: k, message: "env var is set but not declared in the bridge schema (typo or removed config?)" });
  }

  return { ok: errors.length === 0, errors, unknown };
}

/**
 * Default boot-time check: log warnings, don't exit. Keeps dev ergonomic
 * (typo'd vars surface as warnings instead of crashing the editor) while
 * still surfacing problems loudly enough to catch in logs.
 *
 * Call after `config` is loaded (so the configured `LOG_FORMAT` is in effect).
 */
export function validateEnvOrWarn(env: NodeJS.ProcessEnv = process.env): EnvReport {
  const report = validateEnv(env);
  for (const e of report.errors) {
    log("warn", `Env validation: ${e.key} — ${e.message}`);
  }
  for (const u of report.unknown) {
    log("warn", `Env validation: unknown ${u.key}`);
  }
  if (report.errors.length > 0) {
    log(
      "warn",
      `Env validation found ${report.errors.length} invalid and ${report.unknown.length} unknown env var(s). ` +
        "Continuing boot — fix the env vars above to silence these warnings. " +
        "Set STRICT_CONFIG=production to abort boot on validation errors.",
    );
  }
  return report;
}

/**
 * Strict variant — returns the same report but ALSO throws on errors when
 * `STRICT_CONFIG=production` is set. Called by boot (`src/index.ts`) right
 * after `validateEnvOrWarn`, so a production deployment can actually abort
 * on invalid config instead of just logging; also exported standalone for CI
 * scripts and `bun run cli` subcommands that want the same fail-fast check.
 */
export function validateEnvStrict(env: NodeJS.ProcessEnv = process.env): EnvReport {
  const report = validateEnv(env);
  if (report.errors.length > 0 && env.STRICT_CONFIG === "production") {
    throw new Error(
      `STRICT_CONFIG=production: ${report.errors.length} env var(s) failed validation. ` +
        report.errors.map((e) => `${e.key}: ${e.message}`).join("; "),
    );
  }
  return report;
}
