/**
 * Stryker mutation-testing backstop for src/tool-policies/context-budget.ts —
 * closes 5 surviving StringLiteral/TemplateLiteral mutants that a loose
 * `.toContain("compress")` / `.toContain(longText)` check in
 * context-budget.test.ts's "llm_summarize request shapes" describe block
 * cannot catch, because each is a SEPARATE AST node Stryker can independently
 * empty to "":
 *
 *   - SUMMARIZE_SYSTEM_PROMPT (~231-233): 3 string-concat chunks.
 *   - summarizePrompt() (~237-238): 2 of its 3 template-literal chunks (the
 *     3rd, `<tool_response>...`, is already pinned indirectly by the existing
 *     file's `.toContain(longText)` checks and isn't in the survivor list).
 *
 * Driven through a real applyContextBudget() call with a mocked fetch (same
 * pattern as context-budget.test.ts), using the anthropic provider because it
 * puts SUMMARIZE_SYSTEM_PROMPT on its own top-level `system` field (distinct
 * from the user message), letting one request pin all 5 chunks at once. Both
 * callOpenAiCompatible and callAnthropic share the same SUMMARIZE_SYSTEM_PROMPT
 * constant and summarizePrompt() function, so killing these mutants via one
 * provider's request body kills them for both call sites — no need to repeat
 * this against the openai shape too.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { config } from "../../config.js";
import { __resetDbForTesting } from "../../db/connection.js";
import { registry } from "../../mcp/registry.js";
import {
  byteLength,
  applyContextBudget,
  setToolContextBudget,
  __setContextBudgetFetchForTesting,
  __resetContextBudgetForTesting,
} from "../../tool-policies/context-budget.js";
import type { RestToolDefinition } from "../../mcp/types.js";

const CLIENT = "cbmutcb4";
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

describe("SUMMARIZE_SYSTEM_PROMPT + summarizePrompt — per-chunk mutation coverage", () => {
  test("all 3 SUMMARIZE_SYSTEM_PROMPT chunks and both flagged summarizePrompt template chunks survive verbatim, with real dynamic values", async () => {
    await reg();
    configureSecretBox();

    // Distinctive, deliberately-not-round maxResponseBytes so it can't be
    // confused with any other number that might leak into the prompt.
    const MAX_RESPONSE_BYTES = 37;
    await setToolContextBudget(CLIENT, getTool.name, {
      mode: "llm_summarize",
      maxResponseBytes: MAX_RESPONSE_BYTES,
      llm: {
        provider: "anthropic",
        baseUrl: "https://api.anthropic.com",
        model: "claude-haiku-4-5",
        apiKey: "anthropic-secret-cb4",
      },
    });

    // ASCII text so byteLength() === text.length, and long enough to exceed
    // MAX_RESPONSE_BYTES and force the llm_summarize path.
    const inputText = "The quick brown fox jumps over the lazy dog. ".repeat(20);
    const expectedByteLength = byteLength(inputText);
    // Sanity: the two dynamic values must be distinguishable from each other,
    // otherwise a mutant swapping them wouldn't be caught by this test either.
    expect(expectedByteLength).not.toBe(MAX_RESPONSE_BYTES);

    let seenBody: Record<string, unknown> = {};
    __setContextBudgetFetchForTesting((async (_url: string, init: RequestInit) => {
      seenBody = JSON.parse(init.body as string) as Record<string, unknown>;
      return new Response(JSON.stringify({ content: [{ type: "text", text: "anthropic summary" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch);

    const result = await applyContextBudget(CLIENT, getTool.name, `${CLIENT}__${getTool.name}`, inputText);
    expect(result).toEqual({ text: "anthropic summary", applied: "llm_summarize" });

    const system = seenBody.system as string;
    const messages = seenBody.messages as Array<{ role: string; content: string }>;
    const userContent = messages[0].content;

    // ── SUMMARIZE_SYSTEM_PROMPT — line ~231: 1st concat chunk.
    expect(system).toContain("operating under a limited context window");
    // ── SUMMARIZE_SYSTEM_PROMPT — line ~232: 2nd concat chunk.
    expect(system).toContain("compressed-but-faithful summary that preserves every fact, id, and value");
    // ── SUMMARIZE_SYSTEM_PROMPT — line ~233: 3rd concat chunk.
    expect(system).toContain("Never invent data that is not present in the input.");

    // ── summarizePrompt — line ~237: 1st template chunk (static text around
    // the byteLength(text)/maxResponseBytes interpolations).
    expect(userContent).toContain("exceeding this tool's");
    expect(userContent).toContain("-byte context budget.");
    // Dynamic values actually interpolated as their real numbers, not
    // "undefined" or some placeholder.
    expect(userContent).toContain(`is ${expectedByteLength} bytes,`);
    expect(userContent).toContain(`${MAX_RESPONSE_BYTES}-byte context budget.`);

    // ── summarizePrompt — line ~238: 2nd template chunk.
    expect(userContent).toContain("Compress it into a faithful summary targeting roughly");
    expect(userContent).toContain("preserving all information relevant to completing the calling agent's task.");
    expect(userContent).toContain(`targeting roughly ${MAX_RESPONSE_BYTES} bytes or fewer`);
  });
});
