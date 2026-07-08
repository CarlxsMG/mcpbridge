/**
 * Stryker mutation-kill: rowToInternal's llm-presence guard (context-budget.ts
 * line ~70) requires ALL FOUR of llm_provider/llm_base_url/llm_model/
 * llm_api_key_ref to be truthy before `llm` is non-null. The normal write path
 * (setToolContextBudget) always writes all four together or none at all, so
 * no existing test ever exercises a row where only SOME of the four columns
 * are populated — that gap left every `&&` in the 4-term chain free to be
 * flipped to `||` (or the whole expression forced to `true`) without any test
 * noticing. This file inserts partial rows directly into `tool_context_budget`
 * via raw SQL (bypassing setToolContextBudget's all-or-nothing contract) to
 * prove getToolContextBudget() still requires all four fields before treating
 * `llm` as configured.
 */
import { describe, test, expect, beforeEach } from "bun:test";
import { getDb, __resetDbForTesting } from "../../db/connection.js";
import { registry } from "../../mcp/registry.js";
import { getToolContextBudget } from "../../tool-policies/context-budget.js";
import type { RestToolDefinition } from "../../mcp/types.js";

const CLIENT = "cb1svc";
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

/**
 * Inserts a row directly into tool_context_budget with arbitrary (possibly
 * partial) llm_* columns — bypasses setToolContextBudget's all-or-nothing
 * write contract on purpose, to simulate a malformed/partial row (manual data
 * corruption, a partial migration, or a future write-path bug).
 */
function insertRow(
  clientName: string,
  toolName: string,
  llm: {
    provider: string | null;
    baseUrl: string | null;
    model: string | null;
    apiKeyRef: string | null;
  },
): void {
  getDb()
    .query(
      `INSERT INTO tool_context_budget
         (client_name, tool_name, mode, max_response_bytes, llm_provider, llm_base_url, llm_model, llm_api_key_ref, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(clientName, toolName, "truncate", 1000, llm.provider, llm.baseUrl, llm.model, llm.apiKeyRef, Date.now());
}

beforeEach(async () => {
  for (const c of registry.listClients()) await registry.unregister(c.name);
  __resetDbForTesting();
});

describe("getToolContextBudget — rowToInternal llm guard requires ALL FOUR llm_* fields", () => {
  test("llm_provider missing (other three set) -> llm is null", async () => {
    await reg();
    insertRow(CLIENT, getTool.name, {
      provider: null,
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4o-mini",
      apiKeyRef: "ref-1",
    });
    const result = getToolContextBudget(CLIENT, getTool.name);
    expect(result?.llm).toBeNull();
  });

  test("llm_base_url missing (other three set) -> llm is null", async () => {
    await reg();
    insertRow(CLIENT, getTool.name, {
      provider: "openai",
      baseUrl: null,
      model: "gpt-4o-mini",
      apiKeyRef: "ref-1",
    });
    const result = getToolContextBudget(CLIENT, getTool.name);
    expect(result?.llm).toBeNull();
  });

  test("llm_model missing (other three set) -> llm is null", async () => {
    await reg();
    insertRow(CLIENT, getTool.name, {
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      model: null,
      apiKeyRef: "ref-1",
    });
    const result = getToolContextBudget(CLIENT, getTool.name);
    expect(result?.llm).toBeNull();
  });

  test("llm_api_key_ref missing (other three set) -> llm is null", async () => {
    await reg();
    insertRow(CLIENT, getTool.name, {
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4o-mini",
      apiKeyRef: null,
    });
    const result = getToolContextBudget(CLIENT, getTool.name);
    expect(result?.llm).toBeNull();
  });

  test("all four llm_* fields set -> llm is populated (happy path, regression safety)", async () => {
    await reg();
    insertRow(CLIENT, getTool.name, {
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4o-mini",
      apiKeyRef: "ref-1",
    });
    const result = getToolContextBudget(CLIENT, getTool.name);
    expect(result?.llm).toEqual({
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4o-mini",
      apiKeyRef: "ref-1",
    });
  });
});
