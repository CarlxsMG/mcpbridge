/**
 * Validators for per-tool policy payloads and guard/override admin inputs.
 *
 * Each function returns a {@link ValidationResult} discriminated union so the
 * caller can pattern-match with `if (!r.ok) ...; ... r.value` and never has to
 * remember which fields are optional vs required. Originally lived inline in
 * `src/routes/admin.ts` (1634-LOC monolith). Extracted so multiple future
 * per-entity routers can share the same input-validation rules without each
 * owning their own copy.
 *
 * Convention: every validator accepts `unknown` (raw JSON body field) and
 * either:
 *   - returns `{ ok: true, value: null }` when the caller passed `null` /
 *     `false` (interpreted as "clear the config");
 *   - returns `{ ok: true, value: <typed payload> }` when the input is valid;
 *   - returns `{ ok: false, message: <human-readable> }` otherwise.
 *
 * Field names mirror the wire format (`cache.ttlSeconds`, `pagination.strategy`,
 * etc.) so error messages line up one-to-one with what the admin UI sent.
 */
import type { ValidationResult } from "./validation.js";
import type { ClientGuardConfig, ToolGuardConfig, ToolGuardrails, ToolOverride } from "../mcp/types.js";
import type { MockMode } from "../tool-meta/tool-mock.js";
import type { StreamFormat } from "../proxy/streaming.js";
import type { TransformOp } from "../proxy/transform.js";
import type { PaginationStrategy } from "../tool-policies/pagination.js";
import type { QuarantineAction, QuarantineRecoveryMode } from "../tool-policies/quarantine.js";
import type {
  ContextBudgetInput,
  ContextBudgetMode,
  ContextBudgetLlmProvider,
} from "../tool-policies/context-budget.js";
import { MAX_DENY_PATTERNS, MAX_DENY_PATTERN_LENGTH, looksReDoSProne } from "../tool-policies/guardrails.js";
import { MAX_CACHE_TTL_SECONDS } from "../tool-policies/response-cache.js";
import { MAX_PAGINATION_PAGES } from "../tool-policies/pagination.js";
import { MAX_STREAM_EVENTS } from "../proxy/streaming.js";
import { MAX_TRANSFORM_OPS } from "../proxy/transform.js";
import { MIN_CONTEXT_BUDGET_BYTES } from "../tool-policies/context-budget.js";
import { config } from "../config.js";
import { hashApiKey } from "../security/key-hash.js";

// ─── Per-tool policy inputs ─────────────────────────────────────────────────

/** Per-tool response cache — `null`/`false` clears, an object opts the tool in. */
export function validateCacheInput(raw: unknown): ValidationResult<{ enabled: boolean; ttlSeconds: number } | null> {
  if (raw === null || raw === false) return { ok: true, value: null };
  if (typeof raw !== "object") return { ok: false, message: "cache must be an object, null, or false" };
  const obj = raw as Record<string, unknown>;
  const enabled = obj.enabled !== false;
  const ttlSeconds = typeof obj.ttlSeconds === "number" ? obj.ttlSeconds : NaN;
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > MAX_CACHE_TTL_SECONDS) {
    return { ok: false, message: `cache.ttlSeconds must be an integer between 1 and ${MAX_CACHE_TTL_SECONDS}` };
  }
  return { ok: true, value: { enabled, ttlSeconds } };
}

/** Per-tool coalesce — `null`/`false` clears. */
export function validateCoalesceInput(raw: unknown): ValidationResult<{ enabled: boolean } | null> {
  if (raw === null || raw === false) return { ok: true, value: null };
  if (typeof raw !== "object") return { ok: false, message: "coalesce must be an object, null, or false" };
  const obj = raw as Record<string, unknown>;
  const enabled = obj.enabled !== false;
  return { ok: true, value: { enabled } };
}

const QUARANTINE_ACTIONS: readonly QuarantineAction[] = ["block", "force_approval", "observe"];
const QUARANTINE_RECOVERY_MODES: readonly QuarantineRecoveryMode[] = ["auto", "manual"];

/** Per-tool quarantine policy — `null`/`false` clears. */
export function validateQuarantinePolicyInput(raw: unknown): ValidationResult<{
  consecutiveThreshold: number;
  action: QuarantineAction;
  recoveryMode: QuarantineRecoveryMode;
  cooldownMs: number | null;
} | null> {
  if (raw === null || raw === false) return { ok: true, value: null };
  if (typeof raw !== "object") return { ok: false, message: "quarantinePolicy must be an object, null, or false" };
  const obj = raw as Record<string, unknown>;

  const consecutiveThreshold = typeof obj.consecutiveThreshold === "number" ? obj.consecutiveThreshold : NaN;
  if (!Number.isInteger(consecutiveThreshold) || consecutiveThreshold < 1 || consecutiveThreshold > 100) {
    return { ok: false, message: "quarantinePolicy.consecutiveThreshold must be an integer between 1 and 100" };
  }
  if (typeof obj.action !== "string" || !QUARANTINE_ACTIONS.includes(obj.action as QuarantineAction)) {
    return { ok: false, message: `quarantinePolicy.action must be one of ${QUARANTINE_ACTIONS.join(", ")}` };
  }
  if (
    typeof obj.recoveryMode !== "string" ||
    !QUARANTINE_RECOVERY_MODES.includes(obj.recoveryMode as QuarantineRecoveryMode)
  ) {
    return {
      ok: false,
      message: `quarantinePolicy.recoveryMode must be one of ${QUARANTINE_RECOVERY_MODES.join(", ")}`,
    };
  }
  let cooldownMs: number | null = null;
  if (obj.cooldownMs !== undefined && obj.cooldownMs !== null) {
    if (typeof obj.cooldownMs !== "number" || !Number.isInteger(obj.cooldownMs) || obj.cooldownMs < 1000) {
      return { ok: false, message: "quarantinePolicy.cooldownMs must be an integer >= 1000 (or omitted)" };
    }
    cooldownMs = obj.cooldownMs;
  }
  return {
    ok: true,
    value: {
      consecutiveThreshold,
      action: obj.action as QuarantineAction,
      recoveryMode: obj.recoveryMode as QuarantineRecoveryMode,
      cooldownMs,
    },
  };
}

const CONTEXT_BUDGET_MODES: readonly ContextBudgetMode[] = ["truncate", "llm_summarize"];
const CONTEXT_BUDGET_LLM_PROVIDERS: readonly ContextBudgetLlmProvider[] = ["openai", "anthropic"];

/**
 * Per-tool context budget. `null`/`false` clears. An object opts the tool in
 * (`mode` + bounded `maxResponseBytes`); `llm_summarize` adds a required
 * `llm` object (provider/baseUrl/model/apiKey). apiKey is never echoed back
 * — caller stores it via {@link setToolContextBudget} which encrypts through
 * the secrets provider.
 */
export function validateContextBudgetInput(raw: unknown): ValidationResult<ContextBudgetInput | null> {
  if (raw === null || raw === false) return { ok: true, value: null };
  if (typeof raw !== "object") return { ok: false, message: "contextBudget must be an object, null, or false" };
  const obj = raw as Record<string, unknown>;

  if (typeof obj.mode !== "string" || !CONTEXT_BUDGET_MODES.includes(obj.mode as ContextBudgetMode)) {
    return { ok: false, message: `contextBudget.mode must be one of ${CONTEXT_BUDGET_MODES.join(", ")}` };
  }
  const mode = obj.mode as ContextBudgetMode;

  const maxResponseBytes = typeof obj.maxResponseBytes === "number" ? obj.maxResponseBytes : NaN;
  if (
    !Number.isInteger(maxResponseBytes) ||
    maxResponseBytes < MIN_CONTEXT_BUDGET_BYTES ||
    maxResponseBytes > config.maxResponseBytes
  ) {
    return {
      ok: false,
      message: `contextBudget.maxResponseBytes must be an integer between ${MIN_CONTEXT_BUDGET_BYTES} and ${config.maxResponseBytes}`,
    };
  }

  if (mode === "truncate") return { ok: true, value: { mode, maxResponseBytes } };

  const llmRaw = obj.llm;
  if (typeof llmRaw !== "object" || llmRaw === null) {
    return { ok: false, message: "contextBudget.llm is required when mode is 'llm_summarize'" };
  }
  const llm = llmRaw as Record<string, unknown>;
  if (
    typeof llm.provider !== "string" ||
    !CONTEXT_BUDGET_LLM_PROVIDERS.includes(llm.provider as ContextBudgetLlmProvider)
  ) {
    return {
      ok: false,
      message: `contextBudget.llm.provider must be one of ${CONTEXT_BUDGET_LLM_PROVIDERS.join(", ")}`,
    };
  }
  if (typeof llm.baseUrl !== "string" || !llm.baseUrl.trim()) {
    return { ok: false, message: "contextBudget.llm.baseUrl (non-empty string) is required" };
  }
  if (typeof llm.model !== "string" || !llm.model.trim()) {
    return { ok: false, message: "contextBudget.llm.model (non-empty string) is required" };
  }
  if (typeof llm.apiKey !== "string" || !llm.apiKey.trim()) {
    return { ok: false, message: "contextBudget.llm.apiKey (non-empty string) is required" };
  }

  return {
    ok: true,
    value: {
      mode,
      maxResponseBytes,
      llm: {
        provider: llm.provider as ContextBudgetLlmProvider,
        baseUrl: llm.baseUrl.trim(),
        model: llm.model.trim(),
        apiKey: llm.apiKey,
      },
    },
  };
}

export interface PaginationInput {
  enabled: boolean;
  strategy: PaginationStrategy;
  itemsPath: string;
  cursorResponsePath?: string;
  cursorParam?: string;
  pageParam?: string;
  maxPages: number;
}

/**
 * Per-tool pagination — `null`/`false` clears. Each strategy has its own
 * required fields: cursor → response-path + query-param, page → page-param,
 * link → none.
 */
export function validatePaginationInput(raw: unknown): ValidationResult<PaginationInput | null> {
  if (raw === null || raw === false) return { ok: true, value: null };
  if (typeof raw !== "object") return { ok: false, message: "pagination must be an object, null, or false" };
  const obj = raw as Record<string, unknown>;
  const strategy = obj.strategy;
  if (strategy !== "cursor" && strategy !== "page" && strategy !== "link") {
    return { ok: false, message: "pagination.strategy must be 'cursor', 'page', or 'link'" };
  }
  const maxPages = typeof obj.maxPages === "number" ? obj.maxPages : NaN;
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > MAX_PAGINATION_PAGES) {
    return { ok: false, message: `pagination.maxPages must be an integer between 1 and ${MAX_PAGINATION_PAGES}` };
  }
  const value: PaginationInput = {
    enabled: obj.enabled !== false,
    strategy,
    itemsPath: typeof obj.itemsPath === "string" ? obj.itemsPath : "",
    maxPages,
  };
  if (strategy === "cursor") {
    const crp = typeof obj.cursorResponsePath === "string" ? obj.cursorResponsePath : "";
    const cp = typeof obj.cursorParam === "string" ? obj.cursorParam : "";
    if (!crp || !cp) return { ok: false, message: "cursor strategy requires cursorResponsePath and cursorParam" };
    value.cursorResponsePath = crp;
    value.cursorParam = cp;
  } else if (strategy === "page") {
    const pp = typeof obj.pageParam === "string" ? obj.pageParam : "";
    if (!pp) return { ok: false, message: "page strategy requires pageParam" };
    value.pageParam = pp;
  }
  return { ok: true, value };
}

/** Per-tool streaming normalizer — `null`/`false` clears. */
export function validateStreamingInput(
  raw: unknown,
): ValidationResult<{ enabled: boolean; format: StreamFormat; maxEvents: number } | null> {
  if (raw === null || raw === false) return { ok: true, value: null };
  if (typeof raw !== "object") return { ok: false, message: "streaming must be an object, null, or false" };
  const obj = raw as Record<string, unknown>;
  if (obj.format !== "ndjson" && obj.format !== "sse")
    return { ok: false, message: "streaming.format must be 'ndjson' or 'sse'" };
  const maxEvents = typeof obj.maxEvents === "number" ? obj.maxEvents : NaN;
  if (!Number.isInteger(maxEvents) || maxEvents < 1 || maxEvents > MAX_STREAM_EVENTS) {
    return { ok: false, message: `streaming.maxEvents must be an integer between 1 and ${MAX_STREAM_EVENTS}` };
  }
  return { ok: true, value: { enabled: obj.enabled !== false, format: obj.format, maxEvents } };
}

/** Validates an ordered transform op list (set/remove/rename/copy). */
export function validateOps(raw: unknown, label: string): ValidationResult<TransformOp[]> {
  if (raw === undefined) return { ok: true, value: [] };
  if (!Array.isArray(raw)) return { ok: false, message: `${label} must be an array of ops` };
  if (raw.length > MAX_TRANSFORM_OPS) return { ok: false, message: `${label} exceeds ${MAX_TRANSFORM_OPS} ops` };
  const ops: TransformOp[] = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== "object")
      return { ok: false, message: `${label}: each op must be an object` };
    const o = entry as Record<string, unknown>;
    if (o.op === "set") {
      if (typeof o.path !== "string" || !("value" in o))
        return { ok: false, message: `${label}: set requires path + value` };
      ops.push({ op: "set", path: o.path, value: o.value });
    } else if (o.op === "remove") {
      if (typeof o.path !== "string") return { ok: false, message: `${label}: remove requires path` };
      ops.push({ op: "remove", path: o.path });
    } else if (o.op === "rename" || o.op === "copy") {
      if (typeof o.from !== "string" || typeof o.to !== "string")
        return { ok: false, message: `${label}: ${o.op} requires from + to` };
      ops.push({ op: o.op, from: o.from, to: o.to });
    } else {
      return { ok: false, message: `${label}: unknown op '${String(o.op)}'` };
    }
  }
  return { ok: true, value: ops };
}

/** Per-tool transform — `null`/`false` clears. */
export function validateTransformInput(
  raw: unknown,
): ValidationResult<{ enabled: boolean; request: TransformOp[]; response: TransformOp[] } | null> {
  if (raw === null || raw === false) return { ok: true, value: null };
  if (typeof raw !== "object") return { ok: false, message: "transform must be an object, null, or false" };
  const obj = raw as Record<string, unknown>;
  const req = validateOps(obj.request, "transform.request");
  if (!req.ok) return { ok: false, message: req.message };
  const resp = validateOps(obj.response, "transform.response");
  if (!resp.ok) return { ok: false, message: resp.message };
  return { ok: true, value: { enabled: obj.enabled !== false, request: req.value, response: resp.value } };
}

/** Per-tool mock — `null`/`false` clears. Caps the inline response at 1 MB. */
export function validateMockInput(
  raw: unknown,
): ValidationResult<{ enabled: boolean; mode: MockMode; response: string } | null> {
  if (raw === null || raw === false) return { ok: true, value: null };
  if (typeof raw !== "object") return { ok: false, message: "mock must be an object, null, or false" };
  const obj = raw as Record<string, unknown>;
  if (obj.mode !== "always" && obj.mode !== "fallback")
    return { ok: false, message: "mock.mode must be 'always' or 'fallback'" };
  if (typeof obj.response !== "string") return { ok: false, message: "mock.response must be a string" };
  if (obj.response.length > 1_000_000) return { ok: false, message: "mock.response too large (max 1MB)" };
  return { ok: true, value: { enabled: obj.enabled !== false, mode: obj.mode, response: obj.response } };
}

// ─── Tool- / client-level guard inputs ──────────────────────────────────────

/**
 * Per-tool guards. `null` clears; an object enables the listed guards
 * individually. Caller-supplied raw API keys are hashed here, at the
 * validation boundary, so they never propagate to durable storage in plaintext.
 */
export function validateToolGuardInput(input: unknown): ValidationResult<ToolGuardConfig | null> {
  if (input === null) return { ok: true, value: null };
  if (typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, message: "guards must be an object or null" };
  }
  const g = input as Record<string, unknown>;
  const value: ToolGuardConfig = {};

  if (g.rateLimitPerMin !== undefined) {
    if (typeof g.rateLimitPerMin !== "number" || !Number.isFinite(g.rateLimitPerMin) || g.rateLimitPerMin <= 0) {
      return { ok: false, message: "guards.rateLimitPerMin must be a positive number" };
    }
    value.rateLimitPerMin = g.rateLimitPerMin;
  }
  if (g.timeoutMs !== undefined) {
    if (typeof g.timeoutMs !== "number" || !Number.isFinite(g.timeoutMs) || g.timeoutMs <= 0) {
      return { ok: false, message: "guards.timeoutMs must be a positive number" };
    }
    value.timeoutMs = g.timeoutMs;
  }
  if (g.allowedApiKeys !== undefined) {
    if (!Array.isArray(g.allowedApiKeys) || !g.allowedApiKeys.every((k) => typeof k === "string" && k.length > 0)) {
      return { ok: false, message: "guards.allowedApiKeys must be an array of non-empty strings" };
    }
    value.allowedKeyHashes = (g.allowedApiKeys as string[]).map((k) => hashApiKey(k));
  }
  return { ok: true, value };
}

/** Per-tool presentation override (description / param hints / displayName alias). */
export function validateToolOverrideInput(input: unknown): ValidationResult<ToolOverride | null> {
  if (input === null) return { ok: true, value: null };
  if (typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, message: "overrides must be an object or null" };
  }
  const o = input as Record<string, unknown>;
  const value: ToolOverride = {};

  if (o.description !== undefined && o.description !== null) {
    if (typeof o.description !== "string" || o.description.length > 4096) {
      return { ok: false, message: "overrides.description must be a string (<= 4096 chars) or null" };
    }
    if (o.description.length > 0) value.description = o.description;
  }

  if (o.params !== undefined && o.params !== null) {
    if (typeof o.params !== "object" || Array.isArray(o.params)) {
      return { ok: false, message: "overrides.params must be an object" };
    }
    const params: NonNullable<ToolOverride["params"]> = {};
    for (const [p, raw] of Object.entries(o.params as Record<string, unknown>)) {
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
        return { ok: false, message: `overrides.params.${p} must be an object` };
      }
      const desc = (raw as Record<string, unknown>).description;
      if (desc !== undefined && (typeof desc !== "string" || desc.length > 2048)) {
        return { ok: false, message: `overrides.params.${p}.description must be a string (<= 2048 chars)` };
      }
      if (typeof desc === "string" && desc.length > 0) params[p] = { description: desc };
    }
    if (Object.keys(params).length > 0) value.params = params;
  }

  if (o.displayName !== undefined && o.displayName !== null) {
    if (typeof o.displayName !== "string" || !/^[a-z0-9][a-z0-9_-]{0,62}$/.test(o.displayName)) {
      return {
        ok: false,
        message: "overrides.displayName must be lowercase alphanumeric with hyphens/underscores, 1-63 chars",
      };
    }
    value.displayName = o.displayName;
  }

  if (value.description === undefined && value.params === undefined && value.displayName === undefined) {
    return { ok: true, value: null };
  }
  return { ok: true, value };
}

/** Per-tool guardrails (input filtering + response scanning). Empty config returns null. */
export function validateGuardrailsInput(input: unknown): ValidationResult<ToolGuardrails | null> {
  if (input === null) return { ok: true, value: null };
  if (typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, message: "guardrails must be an object or null" };
  }
  const g = input as Record<string, unknown>;
  const value: ToolGuardrails = { denyPatterns: [], blockSecrets: false, scanResponses: false };

  if (g.denyPatterns !== undefined) {
    if (!Array.isArray(g.denyPatterns) || !g.denyPatterns.every((p) => typeof p === "string")) {
      return { ok: false, message: "guardrails.denyPatterns must be an array of strings" };
    }
    if (g.denyPatterns.length > MAX_DENY_PATTERNS) {
      return { ok: false, message: `guardrails.denyPatterns allows at most ${MAX_DENY_PATTERNS} entries` };
    }
    for (const p of g.denyPatterns as string[]) {
      if (p.length > MAX_DENY_PATTERN_LENGTH) {
        return { ok: false, message: `guardrails.denyPatterns entries must be <= ${MAX_DENY_PATTERN_LENGTH} chars` };
      }
      try {
        new RegExp(p);
      } catch {
        return { ok: false, message: `guardrails.denyPatterns contains an invalid regex: ${p.slice(0, 40)}` };
      }
      if (looksReDoSProne(p)) {
        return {
          ok: false,
          message: `guardrails.denyPatterns contains a catastrophic-backtracking (ReDoS) pattern: ${p.slice(0, 40)}`,
        };
      }
    }
    value.denyPatterns = (g.denyPatterns as string[]).map((p) => p.trim()).filter(Boolean);
  }
  if (g.blockSecrets !== undefined) {
    if (typeof g.blockSecrets !== "boolean") return { ok: false, message: "guardrails.blockSecrets must be a boolean" };
    value.blockSecrets = g.blockSecrets;
  }
  if (g.scanResponses !== undefined) {
    if (typeof g.scanResponses !== "boolean")
      return { ok: false, message: "guardrails.scanResponses must be a boolean" };
    value.scanResponses = g.scanResponses;
  }

  if (value.denyPatterns.length === 0 && !value.blockSecrets && !value.scanResponses) return { ok: true, value: null };
  return { ok: true, value };
}

/** Per-client guards — currently a circuit-breaker policy only. */
export function validateClientGuardInput(input: unknown): ValidationResult<ClientGuardConfig | null> {
  if (input === null) return { ok: true, value: null };
  if (typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, message: "guards must be an object or null" };
  }
  const g = input as Record<string, unknown>;
  const cbInput = g.circuitBreaker;
  if (cbInput === undefined) return { ok: true, value: {} };
  if (typeof cbInput !== "object" || cbInput === null || Array.isArray(cbInput)) {
    return { ok: false, message: "guards.circuitBreaker must be an object" };
  }
  const cb = cbInput as Record<string, unknown>;
  const numericFields = ["failureThreshold", "resetTimeoutMs", "halfOpenTimeoutMs", "windowMs"] as const;
  const value: NonNullable<ClientGuardConfig["circuitBreaker"]> = {};
  for (const field of numericFields) {
    if (cb[field] === undefined) continue;
    if (typeof cb[field] !== "number" || !Number.isFinite(cb[field] as number) || (cb[field] as number) <= 0) {
      return { ok: false, message: `guards.circuitBreaker.${field} must be a positive number` };
    }
    value[field] = cb[field] as number;
  }
  return { ok: true, value: { circuitBreaker: value } };
}
