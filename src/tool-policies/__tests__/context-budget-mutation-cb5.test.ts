/**
 * Stryker mutation-testing backstop for src/tool-policies/context-budget.ts's
 * `callOpenAiCompatible` and `estimateMaxTokens` — neither is exported, so
 * every assertion here drives them indirectly through the public
 * `applyContextBudget` entry point (mirroring context-budget.test.ts's
 * established mocked-fetch pattern via `__setContextBudgetFetchForTesting`).
 *
 * Mutants targeted (line numbers as of the reviewed revision of
 * context-budget.ts):
 *
 *  - 258: `llm.baseUrl.replace(/\/+$/, "")` — RegexLiteral (`/\/+$/` weakened)
 *    and the `"/chat/completions"` StringLiteral suffix. context-budget.test.ts's
 *    existing "openai provider" test already asserts the full URL with `toBe`,
 *    but its fixture baseUrl has NO trailing slash, so `.replace()` is a no-op
 *    there and never actually exercises the regex — a mutated regex would
 *    still pass. We add trailing-slash fixtures so the strip is load-bearing.
 *  - 271: `` `OpenAI-compatible summarize request failed with HTTP ${resp.status}` ``
 *    — the whole template literal (StringLiteral mutator collapses it to "").
 *    Not directly observable (the throw is swallowed by applyContextBudget's
 *    catch), so asserted via the exact WARN-log `meta.error` text instead.
 *  - 273: `json.choices?.[0]?.message?.content` — three independent
 *    OptionalChaining mutants (one per `?.`). Each is only observable when the
 *    *specific* link it guards would otherwise dereference a nullish value;
 *    three distinct malformed bodies isolate each one (see comments below).
 *  - 274: `typeof content !== "string" || content.length === 0` —
 *    LogicalOperator (`||` -> `&&`) plus two ConditionalExpression mutants
 *    (each half forced to `false` independently).
 *  - 275: `"OpenAI-compatible summarize response is missing choices[0].message.content"`
 *    — StringLiteral, asserted the same indirect way as the HTTP-status message.
 *  - 282: `Math.min(8_192, Math.max(256, Math.ceil(maxResponseBytes / 3)))` —
 *    Math.min<->Math.max (both occurrences) and the `/ 3` -> `* 3` arithmetic
 *    flip. `estimateMaxTokens` is only called from `callAnthropic` (line 297),
 *    never from the OpenAI path, so it's exercised via the anthropic provider
 *    and its captured `max_tokens` request field.
 *
 * Does NOT modify context-budget.ts or context-budget.test.ts.
 */
import { describe, test, expect, spyOn, beforeEach, afterEach } from "bun:test";
import { config } from "../../config.js";
import { __resetDbForTesting } from "../../db/connection.js";
import { registry } from "../../mcp/registry.js";
import { removeCircuitBreaker } from "../../middleware/circuit-breaker.js";
import * as loggerMod from "../../logger.js";
import {
  applyContextBudget,
  setToolContextBudget,
  __setContextBudgetFetchForTesting,
  __resetContextBudgetForTesting,
} from "../../tool-policies/context-budget.js";
import type { RestToolDefinition } from "../../mcp/types.js";

// ── Local fixtures — mirrors context-budget.test.ts's helpers exactly (none
// of them are exported, so re-declared here rather than modifying that file).
const CLIENT = "cbsvc";
const getTool: RestToolDefinition = {
  name: "get-thing",
  method: "GET",
  endpoint: "/thing",
  description: "d",
  inputSchema: { type: "object", properties: {} },
};

async function reg(): Promise<void> {
  await registry.register(CLIENT, [getTool], "http://example.com/health", "1.2.3.4", "http://example.com", "1.2.3.4");
}

const originalFetch = globalThis.fetch;
const origKey = config.secretEncryptionKey;

function configureSecretBox(): void {
  (config as Record<string, unknown>).secretEncryptionKey = Buffer.alloc(32, 9).toString("base64");
}

function resetAll(): void {
  __resetDbForTesting();
  __resetContextBudgetForTesting();
  (config as Record<string, unknown>).secretEncryptionKey = origKey;
  (config as Record<string, unknown>).retryMaxAttempts = 0;
  removeCircuitBreaker(CLIENT);
  globalThis.fetch = originalFetch;
}

beforeEach(async () => {
  for (const c of registry.listClients()) await registry.unregister(c.name);
  resetAll();
});
afterEach(async () => {
  for (const c of registry.listClients()) await registry.unregister(c.name);
  resetAll();
});

async function configureOpenAiBudget(maxResponseBytes: number): Promise<void> {
  await reg();
  configureSecretBox();
  await setToolContextBudget(CLIENT, getTool.name, {
    mode: "llm_summarize",
    maxResponseBytes,
    llm: { provider: "openai", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini", apiKey: "sk-x" },
  });
}

async function configureAnthropicBudget(maxResponseBytes: number): Promise<void> {
  await reg();
  configureSecretBox();
  await setToolContextBudget(CLIENT, getTool.name, {
    mode: "llm_summarize",
    maxResponseBytes,
    llm: {
      provider: "anthropic",
      baseUrl: "https://api.anthropic.com",
      model: "claude-haiku-4-5",
      apiKey: "anthropic-secret",
    },
  });
}

/** Pulls the meta of the WARN-level "falling back to deterministic truncation" log call. */
function fallbackWarnMeta(logSpy: { mock: { calls: unknown[][] } }): Record<string, unknown> {
  const calls = logSpy.mock.calls as [string, string, Record<string, unknown>?][];
  const match = calls.find(([level, message]) => level === "warn" && message.includes("falling back"));
  expect(match).toBeTruthy();
  return match?.[2] ?? {};
}

// ── URL building: trailing-slash regex + "/chat/completions" literal ───────

describe("callOpenAiCompatible (via applyContextBudget) — URL building", () => {
  test("a single trailing slash on baseUrl is stripped, not doubled", async () => {
    await reg();
    configureSecretBox();
    await setToolContextBudget(CLIENT, getTool.name, {
      mode: "llm_summarize",
      maxResponseBytes: 20,
      llm: { provider: "openai", baseUrl: "https://api.openai.com/v1/", model: "gpt-4o-mini", apiKey: "sk-x" },
    });

    let seenUrl = "";
    __setContextBudgetFetchForTesting((async (url: string) => {
      seenUrl = String(url);
      return Response.json({ choices: [{ message: { content: "ok" } }] });
    }) as unknown as typeof fetch);

    const result = await applyContextBudget(CLIENT, getTool.name, `${CLIENT}__${getTool.name}`, "y".repeat(500));

    expect(result.applied).toBe("llm_summarize");
    // Exact equality: a weakened regex (e.g. only stripping ONE slash via a
    // non-`+` quantifier) still passes on a single trailing slash, so this
    // alone doesn't kill the mutant — the multi-slash case below does — but
    // it does confirm the happy path never doubles the slash.
    expect(seenUrl).toBe("https://api.openai.com/v1/chat/completions");
  });

  test("multiple trailing slashes on baseUrl are all stripped (kills a weakened `+` quantifier)", async () => {
    await reg();
    configureSecretBox();
    await setToolContextBudget(CLIENT, getTool.name, {
      mode: "llm_summarize",
      maxResponseBytes: 20,
      llm: { provider: "openai", baseUrl: "https://api.openai.com/v1///", model: "gpt-4o-mini", apiKey: "sk-x" },
    });

    let seenUrl = "";
    __setContextBudgetFetchForTesting((async (url: string) => {
      seenUrl = String(url);
      return Response.json({ choices: [{ message: { content: "ok" } }] });
    }) as unknown as typeof fetch);

    const result = await applyContextBudget(CLIENT, getTool.name, `${CLIENT}__${getTool.name}`, "y".repeat(500));

    expect(result.applied).toBe("llm_summarize");
    // A regex mutated to match only a single slash (or a `?` quantifier)
    // would leave "//chat/completions" or similar here.
    expect(seenUrl).toBe("https://api.openai.com/v1/chat/completions");
    // Exact-suffix check (task-requested belt-and-braces): kills a mutant
    // that swaps the "/chat/completions" literal for junk of the same or
    // different length.
    expect(seenUrl.endsWith("/chat/completions")).toBe(true);
    expect(seenUrl).not.toContain("//chat/completions");
  });
});

// ── Non-2xx: exact HTTP-status error message (observed via the WARN log) ───

describe("callOpenAiCompatible (via applyContextBudget) — non-2xx error message", () => {
  test("HTTP 503 produces the exact 'failed with HTTP 503' message, logged on fallback", async () => {
    await configureOpenAiBudget(10);
    const logSpy = spyOn(loggerMod, "log").mockImplementation(() => {});
    try {
      __setContextBudgetFetchForTesting(
        (async () => new Response("service unavailable", { status: 503 })) as unknown as typeof fetch,
      );
      const result = await applyContextBudget(CLIENT, getTool.name, `${CLIENT}__${getTool.name}`, "0123456789ABCDEF");
      expect(result.applied).toBe("llm_summarize_fallback_truncate");
      const meta = fallbackWarnMeta(logSpy);
      expect(meta.error).toBe("OpenAI-compatible summarize request failed with HTTP 503");
    } finally {
      logSpy.mockRestore();
    }
  });

  test("HTTP 500 also carries its own status through the message (not a hardcoded one)", async () => {
    await configureOpenAiBudget(10);
    const logSpy = spyOn(loggerMod, "log").mockImplementation(() => {});
    try {
      __setContextBudgetFetchForTesting((async () => new Response("boom", { status: 500 })) as unknown as typeof fetch);
      const result = await applyContextBudget(CLIENT, getTool.name, `${CLIENT}__${getTool.name}`, "0123456789ABCDEF");
      expect(result.applied).toBe("llm_summarize_fallback_truncate");
      const meta = fallbackWarnMeta(logSpy);
      expect(meta.error).toBe("OpenAI-compatible summarize request failed with HTTP 500");
    } finally {
      logSpy.mockRestore();
    }
  });
});

// ── Optional chaining: choices?.[0]?.message?.content — one gap per link ───

describe("callOpenAiCompatible (via applyContextBudget) — choices[0].message.content optional chaining", () => {
  const MISSING_CONTENT_MESSAGE = "OpenAI-compatible summarize response is missing choices[0].message.content";

  test("`choices` entirely absent — exercises the `choices?.[0]` link", async () => {
    await configureOpenAiBudget(10);
    const logSpy = spyOn(loggerMod, "log").mockImplementation(() => {});
    try {
      __setContextBudgetFetchForTesting((async () => Response.json({})) as unknown as typeof fetch);
      const result = await applyContextBudget(CLIENT, getTool.name, `${CLIENT}__${getTool.name}`, "0123456789ABCDEF");
      expect(result.applied).toBe("llm_summarize_fallback_truncate");
      // With the `?.` after `choices` removed, `json.choices` (undefined)
      // would be indexed directly, throwing a native TypeError with a
      // different message than the one below — this exact-match kills that
      // mutant without needing to inspect the mutant's runtime type.
      const meta = fallbackWarnMeta(logSpy);
      expect(meta.error).toBe(MISSING_CONTENT_MESSAGE);
    } finally {
      logSpy.mockRestore();
    }
  });

  test("`choices` is an empty array — exercises the `[0]?.message` link", async () => {
    await configureOpenAiBudget(10);
    const logSpy = spyOn(loggerMod, "log").mockImplementation(() => {});
    try {
      __setContextBudgetFetchForTesting((async () => Response.json({ choices: [] })) as unknown as typeof fetch);
      const result = await applyContextBudget(CLIENT, getTool.name, `${CLIENT}__${getTool.name}`, "0123456789ABCDEF");
      expect(result.applied).toBe("llm_summarize_fallback_truncate");
      const meta = fallbackWarnMeta(logSpy);
      expect(meta.error).toBe(MISSING_CONTENT_MESSAGE);
    } finally {
      logSpy.mockRestore();
    }
  });

  test("`choices[0]` has no `message` key — exercises the `message?.content` link", async () => {
    await configureOpenAiBudget(10);
    const logSpy = spyOn(loggerMod, "log").mockImplementation(() => {});
    try {
      __setContextBudgetFetchForTesting((async () => Response.json({ choices: [{}] })) as unknown as typeof fetch);
      const result = await applyContextBudget(CLIENT, getTool.name, `${CLIENT}__${getTool.name}`, "0123456789ABCDEF");
      expect(result.applied).toBe("llm_summarize_fallback_truncate");
      const meta = fallbackWarnMeta(logSpy);
      expect(meta.error).toBe(MISSING_CONTENT_MESSAGE);
    } finally {
      logSpy.mockRestore();
    }
  });
});

// ── Content validation: `typeof content !== "string" || content.length === 0` ─

describe("callOpenAiCompatible (via applyContextBudget) — content validation", () => {
  const MISSING_CONTENT_MESSAGE = "OpenAI-compatible summarize response is missing choices[0].message.content";

  test("empty-string content (right-hand `length === 0` side, and the `||`) falls back to truncate", async () => {
    await configureOpenAiBudget(10);
    const logSpy = spyOn(loggerMod, "log").mockImplementation(() => {});
    try {
      __setContextBudgetFetchForTesting((async () =>
        Response.json({ choices: [{ message: { content: "" } }] })) as unknown as typeof fetch);
      const result = await applyContextBudget(CLIENT, getTool.name, `${CLIENT}__${getTool.name}`, "0123456789ABCDEF");
      // A `||` -> `&&` mutant, or a mutant forcing the `length === 0` half to
      // `false`, would both treat "" as valid content and return
      // `applied: "llm_summarize"` with empty text instead of falling back.
      expect(result.applied).toBe("llm_summarize_fallback_truncate");
      expect(result.text).toContain("kept 10 of 16 bytes");
      const meta = fallbackWarnMeta(logSpy);
      expect(meta.error).toBe(MISSING_CONTENT_MESSAGE);
    } finally {
      logSpy.mockRestore();
    }
  });

  test("non-string, non-nullish content (left-hand `typeof` side forced false) falls back to truncate", async () => {
    await configureOpenAiBudget(10);
    const logSpy = spyOn(loggerMod, "log").mockImplementation(() => {});
    try {
      // A number has no meaningful `.length === 0` check that would coincide
      // with real behavior: if the `typeof content !== "string"` half were
      // forced to `false`, `(42).length` is `undefined`, so
      // `undefined === 0` is `false` — the mutant would treat `42` as valid
      // and return it as-is, never throwing and never falling back.
      __setContextBudgetFetchForTesting((async () =>
        Response.json({ choices: [{ message: { content: 42 } }] })) as unknown as typeof fetch);
      const result = await applyContextBudget(CLIENT, getTool.name, `${CLIENT}__${getTool.name}`, "0123456789ABCDEF");
      expect(result.applied).toBe("llm_summarize_fallback_truncate");
      expect(result.text).toContain("kept 10 of 16 bytes");
      const meta = fallbackWarnMeta(logSpy);
      expect(meta.error).toBe(MISSING_CONTENT_MESSAGE);
    } finally {
      logSpy.mockRestore();
    }
  });

  test("null content (non-string, but `.length` throws instead of coincidentally passing) falls back to truncate", async () => {
    await configureOpenAiBudget(10);
    const logSpy = spyOn(loggerMod, "log").mockImplementation(() => {});
    try {
      __setContextBudgetFetchForTesting((async () =>
        Response.json({ choices: [{ message: { content: null } }] })) as unknown as typeof fetch);
      const result = await applyContextBudget(CLIENT, getTool.name, `${CLIENT}__${getTool.name}`, "0123456789ABCDEF");
      expect(result.applied).toBe("llm_summarize_fallback_truncate");
      const meta = fallbackWarnMeta(logSpy);
      expect(meta.error).toBe(MISSING_CONTENT_MESSAGE);
    } finally {
      logSpy.mockRestore();
    }
  });
});

// ── estimateMaxTokens (unexported — only reachable via callAnthropic) ──────

describe("estimateMaxTokens (via the anthropic path's max_tokens field)", () => {
  test("small maxResponseBytes is floored at 256 (kills Math.max(256,..) -> Math.min(256,..))", async () => {
    await configureAnthropicBudget(10);
    let seenBody: Record<string, unknown> = {};
    __setContextBudgetFetchForTesting((async (_url: string, init: RequestInit) => {
      seenBody = JSON.parse(init.body as string) as Record<string, unknown>;
      return Response.json({ content: [{ type: "text", text: "summary" }] });
    }) as unknown as typeof fetch);

    const result = await applyContextBudget(CLIENT, getTool.name, `${CLIENT}__${getTool.name}`, "0123456789ABCDEF");
    expect(result.applied).toBe("llm_summarize");
    // Real: ceil(10/3)=4 -> max(256,4)=256 -> min(8192,256)=256.
    // Math.max->Math.min mutant: min(256,4)=4 -> min(8192,4)=4 (wrong).
    expect(seenBody.max_tokens).toBe(256);
  });

  test("large maxResponseBytes is capped at 8192 (kills the outer Math.min -> Math.max)", async () => {
    await configureAnthropicBudget(100_000);
    let seenBody: Record<string, unknown> = {};
    __setContextBudgetFetchForTesting((async (_url: string, init: RequestInit) => {
      seenBody = JSON.parse(init.body as string) as Record<string, unknown>;
      return Response.json({ content: [{ type: "text", text: "summary" }] });
    }) as unknown as typeof fetch);

    const result = await applyContextBudget(CLIENT, getTool.name, `${CLIENT}__${getTool.name}`, "z".repeat(100_001));
    expect(result.applied).toBe("llm_summarize");
    // Real: ceil(100000/3)=33334 -> max(256,33334)=33334 -> min(8192,33334)=8192.
    // Outer Math.min->Math.max mutant: max(8192,33334)=33334 (wrong).
    expect(seenBody.max_tokens).toBe(8192);
  });

  test("mid-range maxResponseBytes hits an exact hand-computed value (kills the /3 -> *3 arithmetic flip)", async () => {
    await configureAnthropicBudget(3000);
    let seenBody: Record<string, unknown> = {};
    __setContextBudgetFetchForTesting((async (_url: string, init: RequestInit) => {
      seenBody = JSON.parse(init.body as string) as Record<string, unknown>;
      return Response.json({ content: [{ type: "text", text: "summary" }] });
    }) as unknown as typeof fetch);

    const result = await applyContextBudget(CLIENT, getTool.name, `${CLIENT}__${getTool.name}`, "z".repeat(3001));
    expect(result.applied).toBe("llm_summarize");
    // Real: ceil(3000/3)=1000 -> max(256,1000)=1000 -> min(8192,1000)=1000.
    // `/3`->`*3` mutant: ceil(3000*3)=9000 -> max(256,9000)=9000 ->
    // min(8192,9000)=8192 — still != 1000, so exact equality catches it even
    // though the outer clamp partially masks the flip.
    expect(seenBody.max_tokens).toBe(1000);
  });
});
