/**
 * Stryker mutation-testing backstop — cluster CB7 (context-budget.ts
 * applyContextBudget, L336-368), closing 9 surviving mutants:
 *
 *   1. `byteLength(text) <= cfg.maxResponseBytes` (EqualityOperator '<=' -> '<')
 *      — an exact-equal-to-budget text must take the early "none" return
 *      (asserted via no fetch call, mirroring the sibling suite's
 *      `fetchCalled` flag pattern) rather than falling through to
 *      truncate/summarize.
 *
 *   2. `cfg.mode === "llm_summarize" && cfg.llm` (LogicalOperator '&&' -> '||';
 *      ConditionalExpression -> 'true') — reachable via a row with
 *      mode="llm_summarize" but all llm_* columns NULL. The `tool_context_budget`
 *      table (migration 49) has no CHECK constraint tying `mode` to the llm_*
 *      columns — only `setToolContextBudget`'s application-level logic keeps
 *      them consistent — so this state is constructible with a direct raw
 *      INSERT, mirroring the `INSERT INTO ... RETURNING` raw-row technique
 *      used elsewhere in this codebase (e.g.
 *      src/security/__tests__/mcp-key-store.test.ts's `makeConsumer`) for
 *      constructing DB states the normal write path can't produce. With this
 *      row, `getToolContextBudget` (rowToInternal) yields `{ mode:
 *      "llm_summarize", llm: null }`; real code's `&&` must fall through to
 *      the plain truncate path without ever calling `summarizeWithLlm` (which
 *      would deref `llm.apiKeyRef` and throw). A mutated `||` or a forced
 *      `true` would instead enter the try block and call summarizeWithLlm
 *      with a null llm, changing the outcome.
 *
 *   3. Both `log()` calls' exact level/message/meta object, asserted via
 *      `spyOn(logger, "log")` around a successful llm_summarize call (kills
 *      the "info"/message/meta-emptied-to-{} mutants) and a failing one
 *      (kills the "warn"/message/meta-emptied-to-{} mutants, including the
 *      `error` field's Error-.message extraction).
 */
import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { config } from "../../config.js";
import { getDb, __resetDbForTesting } from "../../db/connection.js";
import { registry } from "../../mcp/registry.js";
import { removeCircuitBreaker } from "../../middleware/circuit-breaker.js";
import * as logger from "../../logger.js";
import {
  applyContextBudget,
  setToolContextBudget,
  byteLength,
  __setContextBudgetFetchForTesting,
  __resetContextBudgetForTesting,
} from "../../tool-policies/context-budget.js";
import type { RestToolDefinition } from "../../mcp/types.js";

const CLIENT = "cb7svc";
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

/**
 * Directly inserts a `tool_context_budget` row with mode="llm_summarize" but
 * every llm_* column NULL — a state the normal `setToolContextBudget` write
 * path never produces (it only sets llm_* when mode is "llm_summarize", and
 * always sets them all together), but which the schema itself does not
 * forbid. This reproduces `rowToInternal`'s `llm: null` branch while
 * `mode === "llm_summarize"`.
 */
function insertMismatchedRow(clientName: string, toolName: string, maxResponseBytes: number): void {
  getDb()
    .query(
      `INSERT INTO tool_context_budget
         (client_name, tool_name, mode, max_response_bytes, llm_provider, llm_base_url, llm_model, llm_api_key_ref, updated_at)
       VALUES (?, ?, 'llm_summarize', ?, NULL, NULL, NULL, NULL, ?)`,
    )
    .run(clientName, toolName, maxResponseBytes, Date.now());
}

describe("applyContextBudget — exact-boundary byte length (<=)", () => {
  test("text whose byte length exactly equals maxResponseBytes stays 'none' — no truncate, no fetch", async () => {
    await reg();
    await setToolContextBudget(CLIENT, getTool.name, { mode: "truncate", maxResponseBytes: 16 });

    let fetchCalled = false;
    __setContextBudgetFetchForTesting((async () => {
      fetchCalled = true;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch);

    const text = "0123456789ABCDEF"; // exactly 16 bytes, ASCII
    expect(byteLength(text)).toBe(16);

    const result = await applyContextBudget(CLIENT, getTool.name, `${CLIENT}__${getTool.name}`, text);
    expect(result).toEqual({ text, applied: "none" });
    expect(fetchCalled).toBe(false);
  });

  test("one byte over the budget IS processed (truncated) — sanity check for the boundary above", async () => {
    await reg();
    await setToolContextBudget(CLIENT, getTool.name, { mode: "truncate", maxResponseBytes: 16 });
    const text = "0123456789ABCDEFG"; // 17 bytes — one over budget
    expect(byteLength(text)).toBe(17);

    const result = await applyContextBudget(CLIENT, getTool.name, `${CLIENT}__${getTool.name}`, text);
    expect(result.applied).toBe("truncate");
    expect(result.text).not.toEqual(text);
  });
});

describe("applyContextBudget — mode=llm_summarize with no llm config (DB-level mismatch)", () => {
  test("falls through to plain truncate, never invokes summarizeWithLlm (no fetch call)", async () => {
    await reg();
    insertMismatchedRow(CLIENT, getTool.name, 10);

    let fetchCalled = false;
    __setContextBudgetFetchForTesting((async () => {
      fetchCalled = true;
      return new Response(JSON.stringify({ choices: [{ message: { content: "should never get here" } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch);

    const result = await applyContextBudget(CLIENT, getTool.name, `${CLIENT}__${getTool.name}`, "0123456789ABCDEF");

    expect(result.applied).toBe("truncate");
    expect(result.text).toContain("kept 10 of 16 bytes");
    expect(fetchCalled).toBe(false);
  });
});

describe("applyContextBudget — exact log() calls around llm_summarize", () => {
  test("successful summarize logs exactly: info level, exact message, exact meta (tool/client/provider only)", async () => {
    await reg();
    configureSecretBox();
    await setToolContextBudget(CLIENT, getTool.name, {
      mode: "llm_summarize",
      maxResponseBytes: 20,
      llm: { provider: "openai", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini", apiKey: "sk-secret" },
    });

    __setContextBudgetFetchForTesting(
      (async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: "compressed summary" } }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as unknown as typeof fetch,
    );

    const logSpy = spyOn(logger, "log").mockImplementation(() => {});
    try {
      const mcpToolName = `${CLIENT}__${getTool.name}`;
      const result = await applyContextBudget(CLIENT, getTool.name, mcpToolName, "y".repeat(500));

      expect(result).toEqual({ text: "compressed summary", applied: "llm_summarize" });
      expect(logSpy).toHaveBeenCalledWith("info", "Context budget: response compressed by configured LLM", {
        tool: mcpToolName,
        client: CLIENT,
        provider: "openai",
      });
      // Exactly one call, and it must be exactly this shape — no extra/missing meta keys.
      expect(logSpy).toHaveBeenCalledTimes(1);
      const [level, message, meta] = logSpy.mock.calls[0];
      expect(level).toBe("info");
      expect(message).toBe("Context budget: response compressed by configured LLM");
      expect(Object.keys(meta as Record<string, unknown>).sort()).toEqual(["client", "provider", "tool"]);
    } finally {
      logSpy.mockRestore();
    }
  });

  test("failing summarize (thrown Error) logs exactly: warn level, exact message, exact meta incl. error.message", async () => {
    await reg();
    configureSecretBox();
    await setToolContextBudget(CLIENT, getTool.name, {
      mode: "llm_summarize",
      maxResponseBytes: 10,
      llm: { provider: "openai", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini", apiKey: "sk-secret" },
    });

    __setContextBudgetFetchForTesting((async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch);

    const logSpy = spyOn(logger, "log").mockImplementation(() => {});
    try {
      const mcpToolName = `${CLIENT}__${getTool.name}`;
      const result = await applyContextBudget(CLIENT, getTool.name, mcpToolName, "0123456789ABCDEF");

      expect(result.applied).toBe("llm_summarize_fallback_truncate");
      expect(logSpy).toHaveBeenCalledWith(
        "warn",
        "Context budget: LLM summarization failed — falling back to deterministic truncation",
        {
          tool: mcpToolName,
          client: CLIENT,
          provider: "openai",
          error: "ECONNREFUSED",
        },
      );
      expect(logSpy).toHaveBeenCalledTimes(1);
      const [level, message, meta] = logSpy.mock.calls[0];
      expect(level).toBe("warn");
      expect(message).toBe("Context budget: LLM summarization failed — falling back to deterministic truncation");
      expect(Object.keys(meta as Record<string, unknown>).sort()).toEqual(["client", "error", "provider", "tool"]);
    } finally {
      logSpy.mockRestore();
    }
  });

  test("failing summarize (non-Error throw) logs error field as String(err)", async () => {
    await reg();
    configureSecretBox();
    await setToolContextBudget(CLIENT, getTool.name, {
      mode: "llm_summarize",
      maxResponseBytes: 10,
      llm: { provider: "anthropic", baseUrl: "https://api.anthropic.com", model: "claude-haiku-4-5", apiKey: "sk-x" },
    });

    __setContextBudgetFetchForTesting((async () => {
      throw "raw string failure";
    }) as unknown as typeof fetch);

    const logSpy = spyOn(logger, "log").mockImplementation(() => {});
    try {
      const mcpToolName = `${CLIENT}__${getTool.name}`;
      const result = await applyContextBudget(CLIENT, getTool.name, mcpToolName, "0123456789ABCDEF");

      expect(result.applied).toBe("llm_summarize_fallback_truncate");
      expect(logSpy).toHaveBeenCalledWith(
        "warn",
        "Context budget: LLM summarization failed — falling back to deterministic truncation",
        {
          tool: mcpToolName,
          client: CLIENT,
          provider: "anthropic",
          error: "raw string failure",
        },
      );
    } finally {
      logSpy.mockRestore();
    }
  });
});
