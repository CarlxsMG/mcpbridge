/**
 * P2/CB6 — Stryker mutation-testing gap closure for `callAnthropic` in
 * ../../tool-policies/context-budget.ts (structurally parallel to
 * `callOpenAiCompatible`, closed separately). Targets ~10 surviving mutants:
 *
 *   - URL building: the `.replace(/\/+$/, "")` regex, and the "/v1/messages"
 *     string literal.
 *   - The non-2xx branch's template-literal error message (collapsed to "").
 *   - `json.content?.find(...)`: the `?.` removal, the find predicate's whole
 *     condition forced `true`, the `&&` flipped to `||`, and each half of the
 *     `&&` independently forced `false`.
 *   - `!block?.text`: the whole condition forced `false`, the `?.` removal,
 *     and the "missing content[] text block" string literal (emptied).
 *
 * Investigation note — `json.content?.find(...)` optional-chaining mutant:
 * removing the `?.` only changes behavior when `json.content` is nullish
 * (`null` or missing). In that case `null.find(...)` / `undefined.find(...)`
 * throws a TypeError *synchronously inside* `callAnthropic`. Since
 * `callAnthropic` is async, that throw becomes a rejected promise, which
 * propagates up through `summarizeWithLlm` to the single `try/catch` in
 * `applyContextBudget` (context-budget.ts lines ~347-364) — the SAME catch
 * that handles the deliberate `throw new Error("Anthropic summarize response
 * is missing content[] text block")` for the ordinary "no matching block"
 * case. Both paths produce the identical black-box outcome
 * `applied: "llm_summarize_fallback_truncate"` with the (redacted) text
 * truncated — so the outcome alone cannot distinguish them, exactly as the
 * task brief anticipated.
 *
 * However, the catch block also logs `err.message` via `log("warn", ...,
 * { error: ... })`. Correct code (with `?.`) always logs the exact string
 * "Anthropic summarize response is missing content[] text block" for a
 * missing/empty `content`. The `?.`-removed mutant instead logs whatever
 * TypeError message the runtime produces for reading `.find` off `null`/
 * `undefined` — a different string. That gives a real, non-equivalent,
 * distinguishing observation: asserting the exact logged `error` text kills
 * this mutant. See "content: null" / "content missing" tests below — this is
 * a genuine test, not a documented-equivalent concession.
 */
import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { config } from "../../config.js";
import { __resetDbForTesting } from "../../db/connection.js";
import { registry } from "../../mcp/registry.js";
import { removeCircuitBreaker } from "../../middleware/circuit-breaker.js";
import {
  applyContextBudget,
  setToolContextBudget,
  __setContextBudgetFetchForTesting,
  __resetContextBudgetForTesting,
} from "../../tool-policies/context-budget.js";
import type { RestToolDefinition } from "../../mcp/types.js";
import * as loggerMod from "../../logger.js";

const CLIENT = "cb6svc";
const getTool: RestToolDefinition = {
  name: "get-thing",
  method: "GET",
  endpoint: "/thing",
  description: "d",
  inputSchema: { type: "object", properties: {} },
};
const MCP_TOOL_NAME = `${CLIENT}__${getTool.name}`;

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

/** Registers the tool, configures the secrets box, and sets an anthropic llm_summarize budget. */
async function configureAnthropicBudget(baseUrl: string, maxResponseBytes = 10): Promise<void> {
  await reg();
  configureSecretBox();
  await setToolContextBudget(CLIENT, getTool.name, {
    mode: "llm_summarize",
    maxResponseBytes,
    llm: { provider: "anthropic", baseUrl, model: "claude-haiku-4-5", apiKey: "anthropic-secret-cb6" },
  });
}

// Text that always exceeds the 10-byte budgets configured above, so every
// call in this file actually reaches the llm_summarize branch.
const OVER_BUDGET_TEXT = "0123456789ABCDEF"; // 16 bytes

// ── URL building: regex + string literal ────────────────────────────────────

describe("callAnthropic — URL building", () => {
  test("baseUrl with a single trailing slash produces the exact /v1/messages URL (not doubled)", async () => {
    await configureAnthropicBudget("https://api.anthropic.com/");
    let seenUrl = "";
    __setContextBudgetFetchForTesting((async (url: string) => {
      seenUrl = String(url);
      return Response.json({ content: [{ type: "text", text: "ok" }] });
    }) as unknown as typeof fetch);

    const result = await applyContextBudget(CLIENT, getTool.name, MCP_TOOL_NAME, OVER_BUDGET_TEXT);

    // Exact-string assertion: kills both the /\/+$/ regex mutant (which would
    // leave a doubled slash, e.g. ".../v1/messages" would instead render
    // ".../..." wrong) AND the "/v1/messages" string-literal mutant (emptied
    // or mangled).
    expect(seenUrl).toBe("https://api.anthropic.com/v1/messages");
    expect(result.applied).toBe("llm_summarize");
  });

  test("baseUrl with multiple trailing slashes is fully stripped (kills the `+` quantifier)", async () => {
    await configureAnthropicBudget("https://api.anthropic.com///");
    let seenUrl = "";
    __setContextBudgetFetchForTesting((async (url: string) => {
      seenUrl = String(url);
      return Response.json({ content: [{ type: "text", text: "ok" }] });
    }) as unknown as typeof fetch);

    await applyContextBudget(CLIENT, getTool.name, MCP_TOOL_NAME, OVER_BUDGET_TEXT);

    // A mutant that weakens /\/+$/ to /\/$/ (single slash only) would leave
    // "https://api.anthropic.com//v1/messages" here — distinguishable.
    expect(seenUrl).toBe("https://api.anthropic.com/v1/messages");
  });

  test("baseUrl with no trailing slash is left untouched", async () => {
    await configureAnthropicBudget("https://api.anthropic.com");
    let seenUrl = "";
    __setContextBudgetFetchForTesting((async (url: string) => {
      seenUrl = String(url);
      return Response.json({ content: [{ type: "text", text: "ok" }] });
    }) as unknown as typeof fetch);

    await applyContextBudget(CLIENT, getTool.name, MCP_TOOL_NAME, OVER_BUDGET_TEXT);

    expect(seenUrl).toBe("https://api.anthropic.com/v1/messages");
  });
});

// ── Non-2xx error message (template literal) ────────────────────────────────

describe("callAnthropic — non-2xx response error message", () => {
  test("HTTP 503 falls back to truncate and logs the exact 'HTTP 503' + 'Anthropic summarize request failed' message", async () => {
    await configureAnthropicBudget("https://api.anthropic.com");
    __setContextBudgetFetchForTesting(
      (async () => new Response("service unavailable", { status: 503 })) as unknown as typeof fetch,
    );
    const logSpy = spyOn(loggerMod, "log").mockImplementation(() => {});
    try {
      const result = await applyContextBudget(CLIENT, getTool.name, MCP_TOOL_NAME, OVER_BUDGET_TEXT);

      expect(result.applied).toBe("llm_summarize_fallback_truncate");
      const warnCall = logSpy.mock.calls.find((c) => c[0] === "warn");
      expect(warnCall).toBeDefined();
      const meta = warnCall![2] as Record<string, unknown>;
      // Kills the collapsed-to-empty template literal: a mutant that empties
      // the message would produce meta.error === "" here.
      expect(String(meta.error)).toContain("HTTP 503");
      expect(String(meta.error)).toContain("Anthropic summarize request failed");
      expect(String(meta.error)).toBe("Anthropic summarize request failed with HTTP 503");
    } finally {
      logSpy.mockRestore();
    }
  });
});

// ── json.content?.find(...) predicate (&&, ||, forced true/false) ──────────

describe("callAnthropic — content[] find predicate", () => {
  test("skips a non-'text' typed block and finds the later correct text block", async () => {
    await configureAnthropicBudget("https://api.anthropic.com");
    __setContextBudgetFetchForTesting((async () =>
      Response.json({
        content: [
          { type: "image", text: "ignored" },
          { type: "text", text: "real answer" },
        ],
      })) as unknown as typeof fetch);

    const result = await applyContextBudget(CLIENT, getTool.name, MCP_TOOL_NAME, OVER_BUDGET_TEXT);

    // A forced-true predicate, or && flipped to ||, would wrongly match the
    // first ("image") block since its `text` is a string — producing
    // "ignored" instead of "real answer".
    expect(result).toEqual({ text: "real answer", applied: "llm_summarize" });
  });

  test("skips a 'text' typed block whose text is not a string (number) and finds the later valid one", async () => {
    await configureAnthropicBudget("https://api.anthropic.com");
    __setContextBudgetFetchForTesting((async () =>
      Response.json({
        content: [
          { type: "text", text: 123 },
          { type: "text", text: "real answer" },
        ],
      })) as unknown as typeof fetch);

    const result = await applyContextBudget(CLIENT, getTool.name, MCP_TOOL_NAME, OVER_BUDGET_TEXT);

    // Kills: `typeof b.text === "string"` forced to `true` (would wrongly
    // match the first block and return the number 123 as `text`); also kills
    // the `&&`/half-forced-false mutants indirectly, since those would
    // instead find NO block at all and fall back to truncate.
    expect(result).toEqual({ text: "real answer", applied: "llm_summarize" });
  });

  test("skips a 'text' typed block with a missing text field and finds the later valid one", async () => {
    await configureAnthropicBudget("https://api.anthropic.com");
    __setContextBudgetFetchForTesting((async () =>
      Response.json({
        content: [{ type: "text" }, { type: "text", text: "real answer" }],
      })) as unknown as typeof fetch);

    const result = await applyContextBudget(CLIENT, getTool.name, MCP_TOOL_NAME, OVER_BUDGET_TEXT);

    expect(result).toEqual({ text: "real answer", applied: "llm_summarize" });
  });

  test("each half of the && forced to false would find nothing even with a valid block present (regression guard)", async () => {
    // This test's PASS condition on unmutated code documents the expected
    // "found" behavior that a forced-false half would break (both halves
    // forced false collapse `.find` to always-false, producing fallback
    // truncate instead of "llm_summarize" for an otherwise-valid response).
    await configureAnthropicBudget("https://api.anthropic.com");
    __setContextBudgetFetchForTesting((async () =>
      Response.json({ content: [{ type: "text", text: "solo answer" }] })) as unknown as typeof fetch);

    const result = await applyContextBudget(CLIENT, getTool.name, MCP_TOOL_NAME, OVER_BUDGET_TEXT);

    expect(result).toEqual({ text: "solo answer", applied: "llm_summarize" });
  });
});

// ── !block?.text: falsy-but-found vs genuinely-not-found ────────────────────

describe("callAnthropic — !block?.text falsy check", () => {
  test("a found block with empty-string text falls back to truncate (not simply 'not found')", async () => {
    await configureAnthropicBudget("https://api.anthropic.com");
    __setContextBudgetFetchForTesting((async () =>
      Response.json({ content: [{ type: "text", text: "" }] })) as unknown as typeof fetch);
    const logSpy = spyOn(loggerMod, "log").mockImplementation(() => {});
    try {
      const result = await applyContextBudget(CLIENT, getTool.name, MCP_TOOL_NAME, OVER_BUDGET_TEXT);

      // A mutant that forces `!block?.text` to `false` would skip the throw
      // entirely and `return block.text` (the empty string) as a successful
      // summarization — applied would wrongly be "llm_summarize" with text "".
      expect(result.applied).toBe("llm_summarize_fallback_truncate");
      const warnCall = logSpy.mock.calls.find((c) => c[0] === "warn");
      const meta = warnCall![2] as Record<string, unknown>;
      expect(String(meta.error)).toBe("Anthropic summarize response is missing content[] text block");
    } finally {
      logSpy.mockRestore();
    }
  });

  test("no matching block at all (empty content[]) falls back to truncate with the exact error message", async () => {
    await configureAnthropicBudget("https://api.anthropic.com");
    __setContextBudgetFetchForTesting((async () => Response.json({ content: [] })) as unknown as typeof fetch);
    const logSpy = spyOn(loggerMod, "log").mockImplementation(() => {});
    try {
      const result = await applyContextBudget(CLIENT, getTool.name, MCP_TOOL_NAME, OVER_BUDGET_TEXT);

      expect(result.applied).toBe("llm_summarize_fallback_truncate");
      const warnCall = logSpy.mock.calls.find((c) => c[0] === "warn");
      expect(warnCall).toBeDefined();
      const meta = warnCall![2] as Record<string, unknown>;
      // Kills: the "missing content[] text block" string literal (emptied),
      // the `?.` removal on `block?.text` (would instead throw a TypeError
      // with a different message when block is undefined), and the whole
      // `!block?.text` condition forced to `false` (would instead throw on
      // `block.text` inside `return block.text` with yet another message).
      expect(String(meta.error)).toBe("Anthropic summarize response is missing content[] text block");
    } finally {
      logSpy.mockRestore();
    }
  });

  test("content[] has only non-matching blocks -> same exact fallback message", async () => {
    await configureAnthropicBudget("https://api.anthropic.com");
    __setContextBudgetFetchForTesting((async () =>
      Response.json({ content: [{ type: "image" }] })) as unknown as typeof fetch);
    const logSpy = spyOn(loggerMod, "log").mockImplementation(() => {});
    try {
      const result = await applyContextBudget(CLIENT, getTool.name, MCP_TOOL_NAME, OVER_BUDGET_TEXT);

      expect(result.applied).toBe("llm_summarize_fallback_truncate");
      const warnCall = logSpy.mock.calls.find((c) => c[0] === "warn");
      const meta = warnCall![2] as Record<string, unknown>;
      expect(String(meta.error)).toBe("Anthropic summarize response is missing content[] text block");
    } finally {
      logSpy.mockRestore();
    }
  });
});

// ── json.content?.find(...) optional chaining — the investigated mutant ────

describe("callAnthropic — json.content?.find optional chaining (content null/missing)", () => {
  test("content: null does not throw uncaught and falls back to truncate with the exact 'missing content[] text block' log message", async () => {
    await configureAnthropicBudget("https://api.anthropic.com");
    __setContextBudgetFetchForTesting((async () => Response.json({ content: null })) as unknown as typeof fetch);
    const logSpy = spyOn(loggerMod, "log").mockImplementation(() => {});
    try {
      const result = await applyContextBudget(CLIENT, getTool.name, MCP_TOOL_NAME, OVER_BUDGET_TEXT);

      expect(result.applied).toBe("llm_summarize_fallback_truncate");
      const warnCall = logSpy.mock.calls.find((c) => c[0] === "warn");
      expect(warnCall).toBeDefined();
      const meta = warnCall![2] as Record<string, unknown>;
      // Distinguishing assertion (see file header): with `?.` present, a null
      // `content` safely evaluates `.find(...)` to `undefined` and the code
      // takes the deliberate "missing content[] text block" throw path, logged
      // verbatim. A mutant that removes the `?.` instead lets `null.find(...)`
      // throw a TypeError synchronously — same *outcome* (fallback truncate)
      // but a DIFFERENT logged error string (a runtime TypeError message, not
      // this literal) — so this exact-string assertion kills it.
      expect(String(meta.error)).toBe("Anthropic summarize response is missing content[] text block");
    } finally {
      logSpy.mockRestore();
    }
  });

  test("content missing entirely (undefined) does not throw uncaught and logs the exact same message", async () => {
    await configureAnthropicBudget("https://api.anthropic.com");
    __setContextBudgetFetchForTesting((async () => Response.json({})) as unknown as typeof fetch);
    const logSpy = spyOn(loggerMod, "log").mockImplementation(() => {});
    try {
      const result = await applyContextBudget(CLIENT, getTool.name, MCP_TOOL_NAME, OVER_BUDGET_TEXT);

      expect(result.applied).toBe("llm_summarize_fallback_truncate");
      const warnCall = logSpy.mock.calls.find((c) => c[0] === "warn");
      expect(warnCall).toBeDefined();
      const meta = warnCall![2] as Record<string, unknown>;
      expect(String(meta.error)).toBe("Anthropic summarize response is missing content[] text block");
    } finally {
      logSpy.mockRestore();
    }
  });
});
