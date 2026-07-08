/**
 * Stryker mutation-testing backstop for src/tool-policies/context-budget.ts
 * — CB8, closing the gaps left after the 7-agent CB1-CB7 pass:
 *
 *   - 248:56-250:2 BlockStatement (`__resetContextBudgetForTesting`'s body
 *     — `fetchImpl = fetch;` — emptied, so a stale test-injected fetch mock
 *     would silently persist across tests).
 *   - 260:13-260:19 / 293:13-293:19 StringLiteral ("POST" emptied) — neither
 *     provider's request method was ever asserted, only headers/body.
 *   - 261:32-261:50 / 294:32-294:50 StringLiteral ("application/json"
 *     emptied) — the Content-Type header value was never asserted.
 *   - 347:7-347:35 ConditionalExpression (`cfg.mode === "llm_summarize"`
 *     forced always-true). Unreachable via the NORMAL write path (a
 *     genuine "truncate" row never has llm_* columns populated, so
 *     `cfg.llm` is naturally null regardless of this mutant) — needed the
 *     SAME schema-permits-it-but-the-app-never-writes-it DB-mismatch
 *     technique CB7 used for the opposite case: a "truncate"-mode row
 *     with all four llm_* columns populated anyway.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { config } from "../../config.js";
import { getDb, __resetDbForTesting } from "../../db/connection.js";
import { registry } from "../../mcp/registry.js";
import { removeCircuitBreaker } from "../../middleware/circuit-breaker.js";
import {
  applyContextBudget,
  setToolContextBudget,
  __setContextBudgetFetchForTesting,
  __resetContextBudgetForTesting,
} from "../../tool-policies/context-budget.js";
import type { RestToolDefinition } from "../../mcp/types.js";

const CLIENT = "cb8svc";
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

const OVER_BUDGET_TEXT = "0123456789ABCDEF"; // 16 bytes

describe("__resetContextBudgetForTesting", () => {
  test("actually restores fetchImpl to the real global fetch, not a stale test mock", async () => {
    await reg();
    configureSecretBox();
    await setToolContextBudget(CLIENT, getTool.name, {
      mode: "llm_summarize",
      maxResponseBytes: 5,
      llm: { provider: "openai", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini", apiKey: "sk-x" },
    });

    let staleCustomFetchCalled = false;
    __setContextBudgetFetchForTesting((async () => {
      staleCustomFetchCalled = true;
      return new Response(JSON.stringify({ choices: [{ message: { content: "stale" } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch);

    let globalFetchCalled = false;
    globalThis.fetch = (async () => {
      globalFetchCalled = true;
      return new Response(JSON.stringify({ choices: [{ message: { content: "real" } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    __resetContextBudgetForTesting();

    const result = await applyContextBudget(CLIENT, getTool.name, MCP_TOOL_NAME, OVER_BUDGET_TEXT);

    expect(staleCustomFetchCalled).toBe(false);
    expect(globalFetchCalled).toBe(true);
    expect(result).toEqual({ text: "real", applied: "llm_summarize" });
  });
});

describe("callOpenAiCompatible — request method and Content-Type", () => {
  test("sends a POST with Content-Type: application/json", async () => {
    await reg();
    configureSecretBox();
    await setToolContextBudget(CLIENT, getTool.name, {
      mode: "llm_summarize",
      maxResponseBytes: 5,
      llm: { provider: "openai", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini", apiKey: "sk-x" },
    });

    let seenMethod = "";
    let seenContentType: string | undefined;
    __setContextBudgetFetchForTesting((async (_url: string, init: RequestInit) => {
      seenMethod = String(init.method);
      seenContentType = new Headers(init.headers).get("content-type") ?? undefined;
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch);

    await applyContextBudget(CLIENT, getTool.name, MCP_TOOL_NAME, OVER_BUDGET_TEXT);

    expect(seenMethod).toBe("POST");
    expect(seenContentType).toBe("application/json");
  });
});

describe("callAnthropic — request method and Content-Type", () => {
  test("sends a POST with Content-Type: application/json", async () => {
    await reg();
    configureSecretBox();
    await setToolContextBudget(CLIENT, getTool.name, {
      mode: "llm_summarize",
      maxResponseBytes: 5,
      llm: { provider: "anthropic", baseUrl: "https://api.anthropic.com", model: "claude-haiku-4-5", apiKey: "sk-x" },
    });

    let seenMethod = "";
    let seenContentType: string | undefined;
    __setContextBudgetFetchForTesting((async (_url: string, init: RequestInit) => {
      seenMethod = String(init.method);
      seenContentType = new Headers(init.headers).get("content-type") ?? undefined;
      return new Response(JSON.stringify({ content: [{ type: "text", text: "ok" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch);

    await applyContextBudget(CLIENT, getTool.name, MCP_TOOL_NAME, OVER_BUDGET_TEXT);

    expect(seenMethod).toBe("POST");
    expect(seenContentType).toBe("application/json");
  });
});

// 347:7-347:35 ConditionalExpression [Survived] (`cfg.mode ===
// "llm_summarize"` forced always-true). Unreachable via the normal write
// path — needs a "truncate"-mode row with all four llm_* columns populated
// anyway (schema permits it; setToolContextBudget never writes this shape).
describe("applyContextBudget — mode='truncate' with llm_* columns populated (DB-level mismatch)", () => {
  function insertMismatchedTruncateRow(clientName: string, toolName: string, maxResponseBytes: number): void {
    getDb()
      .query(
        `INSERT INTO tool_context_budget
           (client_name, tool_name, mode, max_response_bytes, llm_provider, llm_base_url, llm_model, llm_api_key_ref, updated_at)
         VALUES (?, ?, 'truncate', ?, 'openai', 'https://api.openai.com/v1', 'gpt-4o-mini', 'some-encrypted-ref', ?)`,
      )
      .run(clientName, toolName, maxResponseBytes, Date.now());
  }

  test("a truncate-mode row never attempts llm_summarize even when llm_* columns are (mistakenly) populated", async () => {
    await reg();
    insertMismatchedTruncateRow(CLIENT, getTool.name, 10);

    let fetchCalled = false;
    __setContextBudgetFetchForTesting((async () => {
      fetchCalled = true;
      return new Response(JSON.stringify({ choices: [{ message: { content: "should never get here" } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch);

    const result = await applyContextBudget(CLIENT, getTool.name, MCP_TOOL_NAME, OVER_BUDGET_TEXT);

    expect(result.applied).toBe("truncate");
    expect(fetchCalled).toBe(false);
  });
});
