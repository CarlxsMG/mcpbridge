/**
 * Stryker mutation-testing backstop for src/routes/admin-validators.ts —
 * domain 8.
 *
 * This file is a pure-function validator module (no Express routes, no DB,
 * no recordAudit calls) — every export is a `validate*Input(raw: unknown):
 * ValidationResult<T>` helper. Tested by direct import + call, not through
 * an Express app (there is no HTTP surface here), mirroring the precedent
 * set by http-errors.ts (also a pure-function file in this same domain).
 */
import { describe, test, expect, afterEach } from "bun:test";
import { config } from "../../config.js";
import { hashApiKey } from "../../security/key-hash.js";
import { MAX_CACHE_TTL_SECONDS } from "../../tool-policies/response-cache.js";
import { MAX_PAGINATION_PAGES } from "../../tool-policies/pagination.js";
import { MAX_STREAM_EVENTS } from "../../proxy/streaming.js";
import { MAX_TRANSFORM_OPS } from "../../proxy/transform.js";
import { MIN_CONTEXT_BUDGET_BYTES } from "../../tool-policies/context-budget.js";
import { MAX_DENY_PATTERNS, MAX_DENY_PATTERN_LENGTH } from "../../tool-policies/guardrails.js";
import {
  validateCacheInput,
  validateCoalesceInput,
  validateQuarantinePolicyInput,
  validateContextBudgetInput,
  validatePaginationInput,
  validateStreamingInput,
  validateOps,
  validateTransformInput,
  validateMockInput,
  validateToolGuardInput,
  validateToolOverrideInput,
  validateGuardrailsInput,
  validateClientGuardInput,
} from "../admin-validators.js";

// ─── validateCacheInput ──────────────────────────────────────────────────
describe("validateCacheInput", () => {
  test("null and false both clear (ok:true, value:null)", () => {
    expect(validateCacheInput(null)).toEqual({ ok: true, value: null });
    expect(validateCacheInput(false)).toEqual({ ok: true, value: null });
  });

  test("non-object raw is rejected with the exact type message", () => {
    expect(validateCacheInput("nope")).toEqual({
      ok: false,
      message: "cache must be an object, null, or false",
    });
    expect(validateCacheInput(5)).toEqual({
      ok: false,
      message: "cache must be an object, null, or false",
    });
  });

  test("enabled defaults true when absent, honors explicit false", () => {
    const r1 = validateCacheInput({ ttlSeconds: 10 });
    expect(r1).toEqual({ ok: true, value: { enabled: true, ttlSeconds: 10 } });
    const r2 = validateCacheInput({ ttlSeconds: 10, enabled: false });
    expect(r2).toEqual({ ok: true, value: { enabled: false, ttlSeconds: 10 } });
    const r3 = validateCacheInput({ ttlSeconds: 10, enabled: true });
    expect(r3).toEqual({ ok: true, value: { enabled: true, ttlSeconds: 10 } });
  });

  test("ttlSeconds boundaries: 1 and MAX_CACHE_TTL_SECONDS are valid, 0 and MAX+1 are not", () => {
    expect(validateCacheInput({ ttlSeconds: 1 }).ok).toBe(true);
    expect(validateCacheInput({ ttlSeconds: MAX_CACHE_TTL_SECONDS }).ok).toBe(true);
    expect(validateCacheInput({ ttlSeconds: 0 })).toEqual({
      ok: false,
      message: `cache.ttlSeconds must be an integer between 1 and ${MAX_CACHE_TTL_SECONDS}`,
    });
    expect(validateCacheInput({ ttlSeconds: MAX_CACHE_TTL_SECONDS + 1 }).ok).toBe(false);
  });

  test("non-integer and wrong-typed (truthy) ttlSeconds are rejected", () => {
    expect(validateCacheInput({ ttlSeconds: 1.5 }).ok).toBe(false);
    expect(validateCacheInput({ ttlSeconds: "100" }).ok).toBe(false);
    expect(validateCacheInput({}).ok).toBe(false);
  });
});

// ─── validateCoalesceInput ───────────────────────────────────────────────
describe("validateCoalesceInput", () => {
  test("null and false both clear", () => {
    expect(validateCoalesceInput(null)).toEqual({ ok: true, value: null });
    expect(validateCoalesceInput(false)).toEqual({ ok: true, value: null });
  });

  test("non-object raw rejected with exact message", () => {
    expect(validateCoalesceInput("x")).toEqual({
      ok: false,
      message: "coalesce must be an object, null, or false",
    });
  });

  test("enabled defaults true, honors explicit false/true", () => {
    expect(validateCoalesceInput({})).toEqual({ ok: true, value: { enabled: true } });
    expect(validateCoalesceInput({ enabled: false })).toEqual({ ok: true, value: { enabled: false } });
    expect(validateCoalesceInput({ enabled: true })).toEqual({ ok: true, value: { enabled: true } });
  });
});

// ─── validateQuarantinePolicyInput ───────────────────────────────────────
describe("validateQuarantinePolicyInput", () => {
  test("null and false both clear", () => {
    expect(validateQuarantinePolicyInput(null)).toEqual({ ok: true, value: null });
    expect(validateQuarantinePolicyInput(false)).toEqual({ ok: true, value: null });
  });

  test("non-object raw rejected", () => {
    expect(validateQuarantinePolicyInput("x")).toEqual({
      ok: false,
      message: "quarantinePolicy must be an object, null, or false",
    });
  });

  test("consecutiveThreshold boundaries 1 and 100 valid; 0, 101, non-integer, wrong-type invalid", () => {
    const base = { action: "block", recoveryMode: "auto" };
    expect(validateQuarantinePolicyInput({ ...base, consecutiveThreshold: 1 }).ok).toBe(true);
    expect(validateQuarantinePolicyInput({ ...base, consecutiveThreshold: 100 }).ok).toBe(true);
    expect(validateQuarantinePolicyInput({ ...base, consecutiveThreshold: 0 })).toEqual({
      ok: false,
      message: "quarantinePolicy.consecutiveThreshold must be an integer between 1 and 100",
    });
    expect(validateQuarantinePolicyInput({ ...base, consecutiveThreshold: 101 }).ok).toBe(false);
    expect(validateQuarantinePolicyInput({ ...base, consecutiveThreshold: 1.5 }).ok).toBe(false);
    expect(validateQuarantinePolicyInput({ ...base, consecutiveThreshold: "5" }).ok).toBe(false);
    expect(validateQuarantinePolicyInput({ ...base }).ok).toBe(false);
  });

  test("action must be one of the enum, wrong type or unknown value rejected", () => {
    const base = { consecutiveThreshold: 3, recoveryMode: "auto" };
    expect(validateQuarantinePolicyInput({ ...base, action: "block" }).ok).toBe(true);
    expect(validateQuarantinePolicyInput({ ...base, action: "force_approval" }).ok).toBe(true);
    expect(validateQuarantinePolicyInput({ ...base, action: "observe" }).ok).toBe(true);
    expect(validateQuarantinePolicyInput({ ...base, action: "nonsense" })).toEqual({
      ok: false,
      message: "quarantinePolicy.action must be one of block, force_approval, observe",
    });
    expect(validateQuarantinePolicyInput({ ...base, action: 5 }).ok).toBe(false);
  });

  test("recoveryMode must be one of the enum, wrong type or unknown value rejected", () => {
    const base = { consecutiveThreshold: 3, action: "block" };
    expect(validateQuarantinePolicyInput({ ...base, recoveryMode: "auto" }).ok).toBe(true);
    expect(validateQuarantinePolicyInput({ ...base, recoveryMode: "manual" }).ok).toBe(true);
    expect(validateQuarantinePolicyInput({ ...base, recoveryMode: "nope" })).toEqual({
      ok: false,
      message: "quarantinePolicy.recoveryMode must be one of auto, manual",
    });
    expect(validateQuarantinePolicyInput({ ...base, recoveryMode: 5 }).ok).toBe(false);
  });

  test("cooldownMs: absent/null -> null; boundary 1000 valid, 999 and non-integer/wrong-type invalid", () => {
    const base = { consecutiveThreshold: 3, action: "block", recoveryMode: "auto" };
    expect(validateQuarantinePolicyInput({ ...base })).toEqual({
      ok: true,
      value: { consecutiveThreshold: 3, action: "block", recoveryMode: "auto", cooldownMs: null },
    });
    expect(validateQuarantinePolicyInput({ ...base, cooldownMs: null })).toEqual({
      ok: true,
      value: { consecutiveThreshold: 3, action: "block", recoveryMode: "auto", cooldownMs: null },
    });
    expect(validateQuarantinePolicyInput({ ...base, cooldownMs: 1000 })).toEqual({
      ok: true,
      value: { consecutiveThreshold: 3, action: "block", recoveryMode: "auto", cooldownMs: 1000 },
    });
    expect(validateQuarantinePolicyInput({ ...base, cooldownMs: 999 })).toEqual({
      ok: false,
      message: "quarantinePolicy.cooldownMs must be an integer >= 1000 (or omitted)",
    });
    expect(validateQuarantinePolicyInput({ ...base, cooldownMs: 1000.5 }).ok).toBe(false);
    expect(validateQuarantinePolicyInput({ ...base, cooldownMs: "1000" }).ok).toBe(false);
  });
});

// ─── validateContextBudgetInput ──────────────────────────────────────────
describe("validateContextBudgetInput", () => {
  const origMaxResponseBytes = config.maxResponseBytes;
  afterEach(() => {
    (config as Record<string, unknown>).maxResponseBytes = origMaxResponseBytes;
  });

  test("null and false both clear", () => {
    expect(validateContextBudgetInput(null)).toEqual({ ok: true, value: null });
    expect(validateContextBudgetInput(false)).toEqual({ ok: true, value: null });
  });

  test("non-object raw rejected", () => {
    expect(validateContextBudgetInput("x")).toEqual({
      ok: false,
      message: "contextBudget must be an object, null, or false",
    });
  });

  test("mode must be one of the enum", () => {
    expect(validateContextBudgetInput({ mode: "nonsense", maxResponseBytes: 1000 })).toEqual({
      ok: false,
      message: "contextBudget.mode must be one of truncate, llm_summarize",
    });
    expect(validateContextBudgetInput({ mode: 5, maxResponseBytes: 1000 }).ok).toBe(false);
  });

  test("maxResponseBytes boundaries: MIN_CONTEXT_BUDGET_BYTES valid, one below invalid", () => {
    expect(validateContextBudgetInput({ mode: "truncate", maxResponseBytes: MIN_CONTEXT_BUDGET_BYTES })).toEqual({
      ok: true,
      value: { mode: "truncate", maxResponseBytes: MIN_CONTEXT_BUDGET_BYTES },
    });
    expect(validateContextBudgetInput({ mode: "truncate", maxResponseBytes: MIN_CONTEXT_BUDGET_BYTES - 1 })).toEqual({
      ok: false,
      message: `contextBudget.maxResponseBytes must be an integer between ${MIN_CONTEXT_BUDGET_BYTES} and ${config.maxResponseBytes}`,
    });
  });

  test("maxResponseBytes upper bound uses config.maxResponseBytes (mutable for cheap boundary testing)", () => {
    (config as Record<string, unknown>).maxResponseBytes = 500;
    expect(validateContextBudgetInput({ mode: "truncate", maxResponseBytes: 500 }).ok).toBe(true);
    expect(validateContextBudgetInput({ mode: "truncate", maxResponseBytes: 501 })).toEqual({
      ok: false,
      message: `contextBudget.maxResponseBytes must be an integer between ${MIN_CONTEXT_BUDGET_BYTES} and 500`,
    });
  });

  test("non-integer / wrong-type maxResponseBytes rejected", () => {
    expect(validateContextBudgetInput({ mode: "truncate", maxResponseBytes: 500.5 }).ok).toBe(false);
    expect(validateContextBudgetInput({ mode: "truncate", maxResponseBytes: "500" }).ok).toBe(false);
    expect(validateContextBudgetInput({ mode: "truncate" }).ok).toBe(false);
  });

  test("truncate mode returns early without requiring/reading llm at all", () => {
    // llm is garbage but must be ignored entirely because mode === "truncate"
    // returns before the llm block is ever reached.
    expect(validateContextBudgetInput({ mode: "truncate", maxResponseBytes: 1000, llm: "garbage" })).toEqual({
      ok: true,
      value: { mode: "truncate", maxResponseBytes: 1000 },
    });
  });

  test("llm_summarize requires an llm object", () => {
    expect(validateContextBudgetInput({ mode: "llm_summarize", maxResponseBytes: 1000 })).toEqual({
      ok: false,
      message: "contextBudget.llm is required when mode is 'llm_summarize'",
    });
    expect(validateContextBudgetInput({ mode: "llm_summarize", maxResponseBytes: 1000, llm: null }).ok).toBe(false);
    expect(validateContextBudgetInput({ mode: "llm_summarize", maxResponseBytes: 1000, llm: "nope" }).ok).toBe(false);
  });

  test("llm.provider must be one of the enum", () => {
    const llmBase = { baseUrl: "https://x", model: "m", apiKey: "k" };
    expect(
      validateContextBudgetInput({
        mode: "llm_summarize",
        maxResponseBytes: 1000,
        llm: { ...llmBase, provider: "nonsense" },
      }),
    ).toEqual({
      ok: false,
      message: "contextBudget.llm.provider must be one of openai, anthropic",
    });
    expect(
      validateContextBudgetInput({ mode: "llm_summarize", maxResponseBytes: 1000, llm: { ...llmBase, provider: 5 } })
        .ok,
    ).toBe(false);
  });

  test("llm.baseUrl / model / apiKey each required (non-empty, non-whitespace-only string)", () => {
    const okLlm = { provider: "openai", baseUrl: "https://x", model: "m", apiKey: "k" };
    expect(
      validateContextBudgetInput({ mode: "llm_summarize", maxResponseBytes: 1000, llm: { ...okLlm, baseUrl: "" } }),
    ).toEqual({ ok: false, message: "contextBudget.llm.baseUrl (non-empty string) is required" });
    expect(
      validateContextBudgetInput({
        mode: "llm_summarize",
        maxResponseBytes: 1000,
        llm: { ...okLlm, baseUrl: "   " },
      }).ok,
    ).toBe(false);
    expect(
      validateContextBudgetInput({ mode: "llm_summarize", maxResponseBytes: 1000, llm: { ...okLlm, baseUrl: 5 } }).ok,
    ).toBe(false);
    expect(
      validateContextBudgetInput({ mode: "llm_summarize", maxResponseBytes: 1000, llm: { ...okLlm, model: "" } }),
    ).toEqual({ ok: false, message: "contextBudget.llm.model (non-empty string) is required" });
    // wrong-type (truthy, non-string) and whitespace-only model — both must
    // short-circuit on the typeof check / trim() before ever reaching a
    // downstream .trim() call on a non-string, which would otherwise throw.
    expect(
      validateContextBudgetInput({ mode: "llm_summarize", maxResponseBytes: 1000, llm: { ...okLlm, model: 5 } }).ok,
    ).toBe(false);
    expect(
      validateContextBudgetInput({
        mode: "llm_summarize",
        maxResponseBytes: 1000,
        llm: { ...okLlm, model: "   " },
      }),
    ).toEqual({ ok: false, message: "contextBudget.llm.model (non-empty string) is required" });
    expect(
      validateContextBudgetInput({ mode: "llm_summarize", maxResponseBytes: 1000, llm: { ...okLlm, apiKey: "" } }),
    ).toEqual({ ok: false, message: "contextBudget.llm.apiKey (non-empty string) is required" });
    expect(
      validateContextBudgetInput({ mode: "llm_summarize", maxResponseBytes: 1000, llm: { ...okLlm, apiKey: "  " } }).ok,
    ).toBe(false);
    // wrong-type (truthy, non-string) apiKey must also short-circuit via the
    // typeof check before a downstream .trim() call on a non-string throws.
    expect(
      validateContextBudgetInput({ mode: "llm_summarize", maxResponseBytes: 1000, llm: { ...okLlm, apiKey: 5 } }).ok,
    ).toBe(false);
  });

  test("valid llm_summarize input trims baseUrl/model but keeps apiKey verbatim", () => {
    const r = validateContextBudgetInput({
      mode: "llm_summarize",
      maxResponseBytes: 2000,
      llm: {
        provider: "anthropic",
        baseUrl: "  https://api.anthropic.com  ",
        model: "  claude  ",
        apiKey: " secret-key ",
      },
    });
    expect(r).toEqual({
      ok: true,
      value: {
        mode: "llm_summarize",
        maxResponseBytes: 2000,
        llm: {
          provider: "anthropic",
          baseUrl: "https://api.anthropic.com",
          model: "claude",
          apiKey: " secret-key ",
        },
      },
    });
  });
});

// ─── validatePaginationInput ─────────────────────────────────────────────
describe("validatePaginationInput", () => {
  test("null and false both clear", () => {
    expect(validatePaginationInput(null)).toEqual({ ok: true, value: null });
    expect(validatePaginationInput(false)).toEqual({ ok: true, value: null });
  });

  test("non-object raw rejected", () => {
    expect(validatePaginationInput("x")).toEqual({
      ok: false,
      message: "pagination must be an object, null, or false",
    });
  });

  test("strategy must be cursor/page/link, anything else rejected", () => {
    expect(validatePaginationInput({ strategy: "nonsense", maxPages: 5 })).toEqual({
      ok: false,
      message: "pagination.strategy must be 'cursor', 'page', or 'link'",
    });
    expect(validatePaginationInput({ maxPages: 5 }).ok).toBe(false);
  });

  test("maxPages boundaries: 1 and MAX_PAGINATION_PAGES valid, 0 and MAX+1 invalid", () => {
    expect(validatePaginationInput({ strategy: "link", maxPages: 1 }).ok).toBe(true);
    expect(validatePaginationInput({ strategy: "link", maxPages: MAX_PAGINATION_PAGES }).ok).toBe(true);
    expect(validatePaginationInput({ strategy: "link", maxPages: 0 })).toEqual({
      ok: false,
      message: `pagination.maxPages must be an integer between 1 and ${MAX_PAGINATION_PAGES}`,
    });
    expect(validatePaginationInput({ strategy: "link", maxPages: MAX_PAGINATION_PAGES + 1 }).ok).toBe(false);
    expect(validatePaginationInput({ strategy: "link", maxPages: 1.5 }).ok).toBe(false);
    expect(validatePaginationInput({ strategy: "link", maxPages: "5" }).ok).toBe(false);
  });

  test("link strategy needs no extra fields; enabled defaults true; itemsPath defaults ''", () => {
    expect(validatePaginationInput({ strategy: "link", maxPages: 3 })).toEqual({
      ok: true,
      value: { enabled: true, strategy: "link", itemsPath: "", maxPages: 3 },
    });
    expect(validatePaginationInput({ strategy: "link", maxPages: 3, enabled: false, itemsPath: "data.items" })).toEqual(
      {
        ok: true,
        value: { enabled: false, strategy: "link", itemsPath: "data.items", maxPages: 3 },
      },
    );
    // non-string itemsPath falls back to the default ""
    expect(validatePaginationInput({ strategy: "link", maxPages: 3, itemsPath: 5 })).toEqual({
      ok: true,
      value: { enabled: true, strategy: "link", itemsPath: "", maxPages: 3 },
    });
  });

  test("cursor strategy requires BOTH cursorResponsePath and cursorParam", () => {
    expect(validatePaginationInput({ strategy: "cursor", maxPages: 3, cursorParam: "cursor" })).toEqual({
      ok: false,
      message: "cursor strategy requires cursorResponsePath and cursorParam",
    });
    expect(validatePaginationInput({ strategy: "cursor", maxPages: 3, cursorResponsePath: "next" })).toEqual({
      ok: false,
      message: "cursor strategy requires cursorResponsePath and cursorParam",
    });
    expect(
      validatePaginationInput({
        strategy: "cursor",
        maxPages: 3,
        cursorResponsePath: "next",
        cursorParam: "cursor",
      }),
    ).toEqual({
      ok: true,
      value: {
        enabled: true,
        strategy: "cursor",
        itemsPath: "",
        maxPages: 3,
        cursorResponsePath: "next",
        cursorParam: "cursor",
      },
    });
  });

  test("cursor strategy rejects a wrong-type (truthy, non-string) cursorResponsePath/cursorParam instead of accepting the raw value", () => {
    // A truthy non-string must fall back to "" (not the raw value) so the
    // subsequent falsy-check still rejects it — never coerced or accepted.
    expect(
      validatePaginationInput({ strategy: "cursor", maxPages: 3, cursorResponsePath: 5, cursorParam: "cursor" }),
    ).toEqual({ ok: false, message: "cursor strategy requires cursorResponsePath and cursorParam" });
    expect(
      validatePaginationInput({ strategy: "cursor", maxPages: 3, cursorResponsePath: "next", cursorParam: 5 }),
    ).toEqual({ ok: false, message: "cursor strategy requires cursorResponsePath and cursorParam" });
  });

  test("page strategy requires pageParam", () => {
    expect(validatePaginationInput({ strategy: "page", maxPages: 3 })).toEqual({
      ok: false,
      message: "page strategy requires pageParam",
    });
    expect(validatePaginationInput({ strategy: "page", maxPages: 3, pageParam: "page" })).toEqual({
      ok: true,
      value: { enabled: true, strategy: "page", itemsPath: "", maxPages: 3, pageParam: "page" },
    });
  });

  test("page strategy rejects a wrong-type (truthy, non-string) pageParam instead of accepting the raw value", () => {
    expect(validatePaginationInput({ strategy: "page", maxPages: 3, pageParam: 5 })).toEqual({
      ok: false,
      message: "page strategy requires pageParam",
    });
  });
});

// ─── validateStreamingInput ──────────────────────────────────────────────
describe("validateStreamingInput", () => {
  test("null and false both clear", () => {
    expect(validateStreamingInput(null)).toEqual({ ok: true, value: null });
    expect(validateStreamingInput(false)).toEqual({ ok: true, value: null });
  });

  test("non-object raw rejected", () => {
    expect(validateStreamingInput("x")).toEqual({
      ok: false,
      message: "streaming must be an object, null, or false",
    });
  });

  test("format must be ndjson or sse", () => {
    expect(validateStreamingInput({ format: "nonsense", maxEvents: 5 })).toEqual({
      ok: false,
      message: "streaming.format must be 'ndjson' or 'sse'",
    });
    expect(validateStreamingInput({ format: "ndjson", maxEvents: 5 }).ok).toBe(true);
    expect(validateStreamingInput({ format: "sse", maxEvents: 5 }).ok).toBe(true);
  });

  test("maxEvents boundaries: 1 and MAX_STREAM_EVENTS valid, 0 and MAX+1 invalid", () => {
    expect(validateStreamingInput({ format: "sse", maxEvents: 1 }).ok).toBe(true);
    expect(validateStreamingInput({ format: "sse", maxEvents: MAX_STREAM_EVENTS }).ok).toBe(true);
    expect(validateStreamingInput({ format: "sse", maxEvents: 0 })).toEqual({
      ok: false,
      message: `streaming.maxEvents must be an integer between 1 and ${MAX_STREAM_EVENTS}`,
    });
    expect(validateStreamingInput({ format: "sse", maxEvents: MAX_STREAM_EVENTS + 1 }).ok).toBe(false);
    expect(validateStreamingInput({ format: "sse", maxEvents: 1.5 }).ok).toBe(false);
    expect(validateStreamingInput({ format: "sse", maxEvents: "5" }).ok).toBe(false);
  });

  test("enabled defaults true, honors explicit false", () => {
    expect(validateStreamingInput({ format: "sse", maxEvents: 5 })).toEqual({
      ok: true,
      value: { enabled: true, format: "sse", maxEvents: 5 },
    });
    expect(validateStreamingInput({ format: "sse", maxEvents: 5, enabled: false })).toEqual({
      ok: true,
      value: { enabled: false, format: "sse", maxEvents: 5 },
    });
  });
});

// ─── validateOps ─────────────────────────────────────────────────────────
describe("validateOps", () => {
  test("undefined raw yields an empty ops array", () => {
    expect(validateOps(undefined, "label")).toEqual({ ok: true, value: [] });
  });

  test("non-array raw rejected with the caller-supplied label in the message", () => {
    expect(validateOps("x", "myLabel")).toEqual({ ok: false, message: "myLabel must be an array of ops" });
    expect(validateOps({}, "myLabel").ok).toBe(false);
  });

  test("array longer than MAX_TRANSFORM_OPS rejected; exactly MAX_TRANSFORM_OPS is fine", () => {
    const exact = Array.from({ length: MAX_TRANSFORM_OPS }, (_, i) => ({ op: "remove", path: `p${i}` }));
    expect(validateOps(exact, "L").ok).toBe(true);
    const overflow = Array.from({ length: MAX_TRANSFORM_OPS + 1 }, (_, i) => ({ op: "remove", path: `p${i}` }));
    expect(validateOps(overflow, "L")).toEqual({ ok: false, message: `L exceeds ${MAX_TRANSFORM_OPS} ops` });
  });

  test("each entry must be a non-null object — a non-null non-object entry gets the SAME exact message as null, not the 'unknown op' fallback", () => {
    expect(validateOps([null], "L")).toEqual({ ok: false, message: "L: each op must be an object" });
    // Asserting the exact message (not just .ok) matters: a mutant that lets
    // a non-null primitive slip past this guard would still end up ok:false
    // via the unrelated "unknown op" fallback further down, but with a
    // DIFFERENT message text — only an exact-message check catches that.
    expect(validateOps(["x"], "L")).toEqual({ ok: false, message: "L: each op must be an object" });
    expect(validateOps([5], "L")).toEqual({ ok: false, message: "L: each op must be an object" });
  });

  test("op 'set' requires a string path AND the 'value' key to be present (even if its value is undefined)", () => {
    expect(validateOps([{ op: "set", value: 5 }], "L")).toEqual({
      ok: false,
      message: "L: set requires path + value",
    });
    expect(validateOps([{ op: "set", path: "a" }], "L")).toEqual({
      ok: false,
      message: "L: set requires path + value",
    });
    expect(validateOps([{ op: "set", path: "a", value: undefined }], "L")).toEqual({
      ok: true,
      value: [{ op: "set", path: "a", value: undefined }],
    });
    expect(validateOps([{ op: "set", path: "a", value: 42 }], "L")).toEqual({
      ok: true,
      value: [{ op: "set", path: "a", value: 42 }],
    });
  });

  test("op 'remove' requires a string path", () => {
    expect(validateOps([{ op: "remove" }], "L")).toEqual({ ok: false, message: "L: remove requires path" });
    expect(validateOps([{ op: "remove", path: 5 }], "L").ok).toBe(false);
    expect(validateOps([{ op: "remove", path: "a" }], "L")).toEqual({
      ok: true,
      value: [{ op: "remove", path: "a" }],
    });
  });

  test("op 'rename' and 'copy' both require string 'from' and 'to'", () => {
    expect(validateOps([{ op: "rename", to: "b" }], "L")).toEqual({
      ok: false,
      message: "L: rename requires from + to",
    });
    expect(validateOps([{ op: "rename", from: "a" }], "L")).toEqual({
      ok: false,
      message: "L: rename requires from + to",
    });
    expect(validateOps([{ op: "copy", from: 5, to: "b" }], "L")).toEqual({
      ok: false,
      message: "L: copy requires from + to",
    });
    expect(validateOps([{ op: "rename", from: "a", to: "b" }], "L")).toEqual({
      ok: true,
      value: [{ op: "rename", from: "a", to: "b" }],
    });
    expect(validateOps([{ op: "copy", from: "a", to: "b" }], "L")).toEqual({
      ok: true,
      value: [{ op: "copy", from: "a", to: "b" }],
    });
  });

  test("unknown op is rejected, coercing the op value via String()", () => {
    expect(validateOps([{ op: "unknown-op" }], "L")).toEqual({
      ok: false,
      message: "L: unknown op 'unknown-op'",
    });
    expect(validateOps([{ op: 123 }], "L")).toEqual({ ok: false, message: "L: unknown op '123'" });
    expect(validateOps([{}], "L")).toEqual({ ok: false, message: "L: unknown op 'undefined'" });
  });
});

// ─── validateTransformInput ──────────────────────────────────────────────
describe("validateTransformInput", () => {
  test("null and false both clear", () => {
    expect(validateTransformInput(null)).toEqual({ ok: true, value: null });
    expect(validateTransformInput(false)).toEqual({ ok: true, value: null });
  });

  test("non-object raw rejected", () => {
    expect(validateTransformInput("x")).toEqual({
      ok: false,
      message: "transform must be an object, null, or false",
    });
  });

  test("request ops errors propagate their own validateOps message", () => {
    expect(validateTransformInput({ request: "not-array" })).toEqual({
      ok: false,
      message: "transform.request must be an array of ops",
    });
  });

  test("response ops errors propagate their own validateOps message (checked independently of request)", () => {
    expect(validateTransformInput({ request: [], response: "not-array" })).toEqual({
      ok: false,
      message: "transform.response must be an array of ops",
    });
    // valid request but invalid response — proves response is validated even
    // when request passed, not short-circuited by some shared flag.
    expect(validateTransformInput({ request: [{ op: "remove", path: "a" }], response: "nope" }).ok).toBe(false);
  });

  test("valid transform with both ops lists and enabled default/explicit", () => {
    const r = validateTransformInput({
      request: [{ op: "remove", path: "a" }],
      response: [{ op: "set", path: "b", value: 1 }],
    });
    expect(r).toEqual({
      ok: true,
      value: {
        enabled: true,
        request: [{ op: "remove", path: "a" }],
        response: [{ op: "set", path: "b", value: 1 }],
      },
    });
    const r2 = validateTransformInput({ enabled: false, request: [], response: [] });
    expect(r2).toEqual({ ok: true, value: { enabled: false, request: [], response: [] } });
  });
});

// ─── validateMockInput ───────────────────────────────────────────────────
describe("validateMockInput", () => {
  test("null and false both clear", () => {
    expect(validateMockInput(null)).toEqual({ ok: true, value: null });
    expect(validateMockInput(false)).toEqual({ ok: true, value: null });
  });

  test("non-object raw rejected", () => {
    expect(validateMockInput("x")).toEqual({
      ok: false,
      message: "mock must be an object, null, or false",
    });
  });

  test("mode must be 'always' or 'fallback'", () => {
    expect(validateMockInput({ mode: "nonsense", response: "r" })).toEqual({
      ok: false,
      message: "mock.mode must be 'always' or 'fallback'",
    });
    expect(validateMockInput({ mode: "always", response: "r" }).ok).toBe(true);
    expect(validateMockInput({ mode: "fallback", response: "r" }).ok).toBe(true);
  });

  test("response must be a string", () => {
    expect(validateMockInput({ mode: "always", response: 5 })).toEqual({
      ok: false,
      message: "mock.response must be a string",
    });
    expect(validateMockInput({ mode: "always" }).ok).toBe(false);
  });

  test("response length boundary: exactly 1MB is fine, 1MB+1 char is rejected", () => {
    const exact = "a".repeat(1_000_000);
    expect(validateMockInput({ mode: "always", response: exact }).ok).toBe(true);
    const overflow = "a".repeat(1_000_001);
    expect(validateMockInput({ mode: "always", response: overflow })).toEqual({
      ok: false,
      message: "mock.response too large (max 1MB)",
    });
  });

  test("enabled defaults true, honors explicit false", () => {
    expect(validateMockInput({ mode: "always", response: "r" })).toEqual({
      ok: true,
      value: { enabled: true, mode: "always", response: "r" },
    });
    expect(validateMockInput({ mode: "fallback", response: "r", enabled: false })).toEqual({
      ok: true,
      value: { enabled: false, mode: "fallback", response: "r" },
    });
  });
});

// ─── validateToolGuardInput ──────────────────────────────────────────────
describe("validateToolGuardInput", () => {
  test("null clears", () => {
    expect(validateToolGuardInput(null)).toEqual({ ok: true, value: null });
  });

  test("non-object OR array input rejected", () => {
    expect(validateToolGuardInput("x")).toEqual({ ok: false, message: "guards must be an object or null" });
    expect(validateToolGuardInput([1, 2])).toEqual({ ok: false, message: "guards must be an object or null" });
  });

  test("empty object is valid and returns an empty guard config", () => {
    expect(validateToolGuardInput({})).toEqual({ ok: true, value: {} });
  });

  test("rateLimitPerMin must be a finite positive number when present", () => {
    expect(validateToolGuardInput({ rateLimitPerMin: 10 })).toEqual({ ok: true, value: { rateLimitPerMin: 10 } });
    expect(validateToolGuardInput({ rateLimitPerMin: 0 })).toEqual({
      ok: false,
      message: "guards.rateLimitPerMin must be a positive number",
    });
    expect(validateToolGuardInput({ rateLimitPerMin: -5 }).ok).toBe(false);
    expect(validateToolGuardInput({ rateLimitPerMin: Infinity }).ok).toBe(false);
    expect(validateToolGuardInput({ rateLimitPerMin: "10" }).ok).toBe(false);
  });

  test("timeoutMs must be a finite positive number when present", () => {
    expect(validateToolGuardInput({ timeoutMs: 5000 })).toEqual({ ok: true, value: { timeoutMs: 5000 } });
    expect(validateToolGuardInput({ timeoutMs: 0 })).toEqual({
      ok: false,
      message: "guards.timeoutMs must be a positive number",
    });
    expect(validateToolGuardInput({ timeoutMs: -1 }).ok).toBe(false);
    expect(validateToolGuardInput({ timeoutMs: Infinity }).ok).toBe(false);
    expect(validateToolGuardInput({ timeoutMs: "5000" }).ok).toBe(false);
  });

  test("allowedApiKeys must be an array of non-empty strings, hashed via the real hashApiKey()", () => {
    expect(validateToolGuardInput({ allowedApiKeys: "not-array" })).toEqual({
      ok: false,
      message: "guards.allowedApiKeys must be an array of non-empty strings",
    });
    expect(validateToolGuardInput({ allowedApiKeys: [""] }).ok).toBe(false);
    expect(validateToolGuardInput({ allowedApiKeys: [5] }).ok).toBe(false);
    const r = validateToolGuardInput({ allowedApiKeys: ["key-one", "key-two"] });
    expect(r).toEqual({
      ok: true,
      value: { allowedKeyHashes: [hashApiKey("key-one"), hashApiKey("key-two")] },
    });
    // sanity: the two hashes are genuinely distinct (a mutant collapsing the
    // .map to always hash the same key would produce identical hashes here)
    expect(hashApiKey("key-one")).not.toBe(hashApiKey("key-two"));
  });

  test("allowedApiKeys is rejected the moment ANY single entry is invalid — a mixed valid/invalid array must still fail (every, not some)", () => {
    // A single-invalid-entry array can't distinguish .every from .some (both
    // agree it's invalid). A MIXED array — one genuinely valid entry plus one
    // invalid one — is required: .every correctly rejects it, but a mutant
    // swapping in .some would incorrectly accept it (since one entry passes).
    expect(validateToolGuardInput({ allowedApiKeys: ["good-key", ""] })).toEqual({
      ok: false,
      message: "guards.allowedApiKeys must be an array of non-empty strings",
    });
  });

  test("allowedApiKeys entries must genuinely be strings — a non-string with a truthy .length must still be rejected", () => {
    // A plain non-string primitive like a number has no .length at all, so it
    // can't distinguish a mutant that drops the `typeof k === "string"` half
    // of the per-entry check (both agree such an entry is invalid either
    // way). A nested array DOES have a truthy .length, which is exactly what
    // that dropped clause exists to catch.
    expect(validateToolGuardInput({ allowedApiKeys: [["nested", "array"]] }).ok).toBe(false);
  });

  test("all three fields combine into one guard config", () => {
    const r = validateToolGuardInput({ rateLimitPerMin: 1, timeoutMs: 2, allowedApiKeys: ["k"] });
    expect(r).toEqual({
      ok: true,
      value: { rateLimitPerMin: 1, timeoutMs: 2, allowedKeyHashes: [hashApiKey("k")] },
    });
  });
});

// ─── validateToolOverrideInput ───────────────────────────────────────────
describe("validateToolOverrideInput", () => {
  test("null clears", () => {
    expect(validateToolOverrideInput(null)).toEqual({ ok: true, value: null });
  });

  test("non-object OR array input rejected", () => {
    expect(validateToolOverrideInput("x")).toEqual({ ok: false, message: "overrides must be an object or null" });
    expect(validateToolOverrideInput([1])).toEqual({ ok: false, message: "overrides must be an object or null" });
  });

  test("empty object (all fields absent) resolves to null", () => {
    expect(validateToolOverrideInput({})).toEqual({ ok: true, value: null });
  });

  test("description: wrong type, too long, or an empty string are each handled distinctly", () => {
    expect(validateToolOverrideInput({ description: 5 })).toEqual({
      ok: false,
      message: "overrides.description must be a string (<= 4096 chars) or null",
    });
    expect(validateToolOverrideInput({ description: "a".repeat(4097) }).ok).toBe(false);
    expect(validateToolOverrideInput({ description: "a".repeat(4096) }).ok).toBe(true);
    // empty string is a *valid* string (passes the length check) but is not
    // assigned onto value (length > 0 guard) — so the overall result is null.
    expect(validateToolOverrideInput({ description: "" })).toEqual({ ok: true, value: null });
    expect(validateToolOverrideInput({ description: "hello" })).toEqual({
      ok: true,
      value: { description: "hello" },
    });
    expect(validateToolOverrideInput({ description: null })).toEqual({ ok: true, value: null });
  });

  test("params: null is treated the same as absent (never enters the params block at all)", () => {
    // If the `o.params !== undefined && o.params !== null` guard were forced
    // true, execution would enter the params block with params===null, and
    // `Object.entries(null)` throws — this fixture would surface that.
    expect(validateToolOverrideInput({ params: null })).toEqual({ ok: true, value: null });
  });

  test("params must be a plain object (not array), each entry must itself be a non-null object", () => {
    expect(validateToolOverrideInput({ params: "x" })).toEqual({
      ok: false,
      message: "overrides.params must be an object",
    });
    expect(validateToolOverrideInput({ params: [1] })).toEqual({
      ok: false,
      message: "overrides.params must be an object",
    });
    expect(validateToolOverrideInput({ params: { a: null } })).toEqual({
      ok: false,
      message: "overrides.params.a must be an object",
    });
    expect(validateToolOverrideInput({ params: { a: "x" } }).ok).toBe(false);
    expect(validateToolOverrideInput({ params: { a: [1] } }).ok).toBe(false);
  });

  test("params.<key>.description: wrong type or too long rejected, boundary 2048 valid", () => {
    expect(validateToolOverrideInput({ params: { a: { description: 5 } } })).toEqual({
      ok: false,
      message: "overrides.params.a.description must be a string (<= 2048 chars)",
    });
    expect(validateToolOverrideInput({ params: { a: { description: "x".repeat(2049) } } }).ok).toBe(false);
    expect(validateToolOverrideInput({ params: { a: { description: "x".repeat(2048) } } }).ok).toBe(true);
  });

  test("params entries with an empty description don't get included; non-empty description sets value.params", () => {
    expect(validateToolOverrideInput({ params: { a: { description: "" } } })).toEqual({ ok: true, value: null });
    expect(validateToolOverrideInput({ params: { a: { description: "hi" }, b: { description: "" } } })).toEqual({
      ok: true,
      value: { params: { a: { description: "hi" } } },
    });
  });

  test("a params entry with NO description key at all (desc undefined) is silently skipped, not an error", () => {
    // If either half of `desc !== undefined && (typeof desc !== "string" ||
    // desc.length > 2048)` were forced true, this would either wrongly
    // error out or throw reading .length off undefined — both differ from
    // the correct silent-skip.
    expect(validateToolOverrideInput({ params: { a: {} } })).toEqual({ ok: true, value: null });
  });

  test("displayName must match the lowercase-alphanumeric-with-hyphen/underscore pattern, 1-63 chars", () => {
    expect(validateToolOverrideInput({ displayName: "valid-name_1" })).toEqual({
      ok: true,
      value: { displayName: "valid-name_1" },
    });
    expect(validateToolOverrideInput({ displayName: 5 })).toEqual({
      ok: false,
      message: "overrides.displayName must be lowercase alphanumeric with hyphens/underscores, 1-63 chars",
    });
    expect(validateToolOverrideInput({ displayName: "Uppercase" }).ok).toBe(false);
    expect(validateToolOverrideInput({ displayName: "-leading-dash" }).ok).toBe(false);
    expect(validateToolOverrideInput({ displayName: "a".repeat(63) }).ok).toBe(true);
    expect(validateToolOverrideInput({ displayName: "a".repeat(64) }).ok).toBe(false);
    expect(validateToolOverrideInput({ displayName: "" }).ok).toBe(false);
    expect(validateToolOverrideInput({ displayName: null })).toEqual({ ok: true, value: null });
  });

  test("combining all three fields yields the full override object", () => {
    const r = validateToolOverrideInput({
      description: "d",
      params: { a: { description: "pd" } },
      displayName: "disp-1",
    });
    expect(r).toEqual({
      ok: true,
      value: { description: "d", params: { a: { description: "pd" } }, displayName: "disp-1" },
    });
  });
});

// ─── validateGuardrailsInput ─────────────────────────────────────────────
describe("validateGuardrailsInput", () => {
  test("null clears", () => {
    expect(validateGuardrailsInput(null)).toEqual({ ok: true, value: null });
  });

  test("non-object OR array input rejected", () => {
    expect(validateGuardrailsInput("x")).toEqual({ ok: false, message: "guardrails must be an object or null" });
    expect(validateGuardrailsInput([1])).toEqual({ ok: false, message: "guardrails must be an object or null" });
  });

  test("all-defaults (empty object) resolves to null", () => {
    expect(validateGuardrailsInput({})).toEqual({ ok: true, value: null });
  });

  test("denyPatterns must be an array of strings", () => {
    expect(validateGuardrailsInput({ denyPatterns: "x" })).toEqual({
      ok: false,
      message: "guardrails.denyPatterns must be an array of strings",
    });
    expect(validateGuardrailsInput({ denyPatterns: [5] }).ok).toBe(false);
  });

  test("denyPatterns length boundary: exactly MAX_DENY_PATTERNS valid, +1 rejected", () => {
    const exact = Array.from({ length: MAX_DENY_PATTERNS }, (_, i) => `p${i}`);
    expect(validateGuardrailsInput({ denyPatterns: exact }).ok).toBe(true);
    const overflow = Array.from({ length: MAX_DENY_PATTERNS + 1 }, (_, i) => `p${i}`);
    expect(validateGuardrailsInput({ denyPatterns: overflow })).toEqual({
      ok: false,
      message: `guardrails.denyPatterns allows at most ${MAX_DENY_PATTERNS} entries`,
    });
  });

  test("each denyPatterns entry length boundary: exactly MAX_DENY_PATTERN_LENGTH valid, +1 rejected", () => {
    expect(validateGuardrailsInput({ denyPatterns: ["a".repeat(MAX_DENY_PATTERN_LENGTH)] }).ok).toBe(true);
    const tooLong = "a".repeat(MAX_DENY_PATTERN_LENGTH + 1);
    expect(validateGuardrailsInput({ denyPatterns: [tooLong] })).toEqual({
      ok: false,
      message: `guardrails.denyPatterns entries must be <= ${MAX_DENY_PATTERN_LENGTH} chars`,
    });
  });

  test("each denyPatterns entry must be a valid regex; invalid regex rejected with a truncated message", () => {
    expect(validateGuardrailsInput({ denyPatterns: ["(unterminated"] })).toEqual({
      ok: false,
      message: "guardrails.denyPatterns contains an invalid regex: (unterminated",
    });
    expect(validateGuardrailsInput({ denyPatterns: ["valid-regex-\\d+"] }).ok).toBe(true);
  });

  test("the invalid-regex message truncates the pattern to 40 chars, not the full (longer) pattern", () => {
    // A short invalid pattern can't distinguish a mutant that drops the
    // .slice(0, 40) truncation — both would produce the same short message.
    // A pattern well over 40 chars is required.
    const longInvalid = "(" + "x".repeat(60); // unterminated group, 61 chars
    expect(longInvalid.length).toBeGreaterThan(40);
    const r = validateGuardrailsInput({ denyPatterns: [longInvalid] });
    expect(r).toEqual({
      ok: false,
      message: `guardrails.denyPatterns contains an invalid regex: ${longInvalid.slice(0, 40)}`,
    });
  });

  test("denyPatterns are trimmed and whitespace-only entries are filtered out", () => {
    const r = validateGuardrailsInput({ denyPatterns: ["  real-pattern  ", "   "] });
    expect(r).toEqual({
      ok: true,
      value: { denyPatterns: ["real-pattern"], blockSecrets: false, scanResponses: false },
    });
  });

  test("blockSecrets must be boolean when present", () => {
    expect(validateGuardrailsInput({ blockSecrets: "yes" })).toEqual({
      ok: false,
      message: "guardrails.blockSecrets must be a boolean",
    });
    expect(validateGuardrailsInput({ blockSecrets: true })).toEqual({
      ok: true,
      value: { denyPatterns: [], blockSecrets: true, scanResponses: false },
    });
    expect(validateGuardrailsInput({ blockSecrets: false })).toEqual({ ok: true, value: null });
  });

  test("scanResponses must be boolean when present", () => {
    expect(validateGuardrailsInput({ scanResponses: "yes" })).toEqual({
      ok: false,
      message: "guardrails.scanResponses must be a boolean",
    });
    expect(validateGuardrailsInput({ scanResponses: true })).toEqual({
      ok: true,
      value: { denyPatterns: [], blockSecrets: false, scanResponses: true },
    });
    expect(validateGuardrailsInput({ scanResponses: false })).toEqual({ ok: true, value: null });
  });

  test("any single non-empty/non-false field is enough to avoid collapsing to null", () => {
    expect(validateGuardrailsInput({ denyPatterns: [], blockSecrets: false, scanResponses: false })).toEqual({
      ok: true,
      value: null,
    });
    expect(validateGuardrailsInput({ denyPatterns: ["x"], blockSecrets: false, scanResponses: false }).ok).toBe(true);
    expect(validateGuardrailsInput({ denyPatterns: ["x"] })).toEqual({
      ok: true,
      value: { denyPatterns: ["x"], blockSecrets: false, scanResponses: false },
    });
  });
});

// ─── validateClientGuardInput ────────────────────────────────────────────
describe("validateClientGuardInput", () => {
  test("null clears", () => {
    expect(validateClientGuardInput(null)).toEqual({ ok: true, value: null });
  });

  test("non-object OR array input rejected", () => {
    expect(validateClientGuardInput("x")).toEqual({ ok: false, message: "guards must be an object or null" });
    expect(validateClientGuardInput([1])).toEqual({ ok: false, message: "guards must be an object or null" });
  });

  test("absent circuitBreaker resolves to a bare {} (not {circuitBreaker: {}})", () => {
    expect(validateClientGuardInput({})).toEqual({ ok: true, value: {} });
  });

  test("circuitBreaker must be a non-null, non-array object when present", () => {
    expect(validateClientGuardInput({ circuitBreaker: "x" })).toEqual({
      ok: false,
      message: "guards.circuitBreaker must be an object",
    });
    expect(validateClientGuardInput({ circuitBreaker: null }).ok).toBe(false);
    expect(validateClientGuardInput({ circuitBreaker: [1] }).ok).toBe(false);
  });

  test("empty circuitBreaker object resolves to { circuitBreaker: {} }", () => {
    expect(validateClientGuardInput({ circuitBreaker: {} })).toEqual({ ok: true, value: { circuitBreaker: {} } });
  });

  for (const field of ["failureThreshold", "resetTimeoutMs", "halfOpenTimeoutMs", "windowMs"] as const) {
    test(`circuitBreaker.${field} must be a finite positive number when present`, () => {
      expect(validateClientGuardInput({ circuitBreaker: { [field]: 5 } })).toEqual({
        ok: true,
        value: { circuitBreaker: { [field]: 5 } },
      });
      expect(validateClientGuardInput({ circuitBreaker: { [field]: 0 } })).toEqual({
        ok: false,
        message: `guards.circuitBreaker.${field} must be a positive number`,
      });
      expect(validateClientGuardInput({ circuitBreaker: { [field]: -1 } }).ok).toBe(false);
      expect(validateClientGuardInput({ circuitBreaker: { [field]: Infinity } }).ok).toBe(false);
      expect(validateClientGuardInput({ circuitBreaker: { [field]: "5" } }).ok).toBe(false);
    });
  }

  test("multiple circuitBreaker fields combine into one value", () => {
    const r = validateClientGuardInput({
      circuitBreaker: { failureThreshold: 3, resetTimeoutMs: 1000, halfOpenTimeoutMs: 500, windowMs: 60000 },
    });
    expect(r).toEqual({
      ok: true,
      value: { circuitBreaker: { failureThreshold: 3, resetTimeoutMs: 1000, halfOpenTimeoutMs: 500, windowMs: 60000 } },
    });
  });
});
