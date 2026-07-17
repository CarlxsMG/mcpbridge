/**
 * Per-tool context budget: deterministic truncation (pure fn), opt-in
 * llm_summarize request shapes for both providers (mocked fetch only — never
 * a real LLM provider), fallback-to-truncate on any LLM failure, and an
 * integration test proving enforcement only ever sees POST-redaction data.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import express from "express";
import type { AddressInfo } from "net";
import type { Server } from "http";
import { config } from "../../config.js";
import { __resetDbForTesting } from "../../db/connection.js";
import { registry } from "../../mcp/registry.js";
import { removeCircuitBreaker } from "../../middleware/circuit-breaker.js";
import { proxyToolCall } from "../../proxy/proxy.js";
import { setRedactionPaths } from "../../content-filtering/redaction.js";
import { requestIdMiddleware } from "../../middleware/request-id.js";
import {
  truncateToBudget,
  byteLength,
  applyContextBudget,
  setToolContextBudget,
  getToolContextBudget,
  __setContextBudgetFetchForTesting,
  __resetContextBudgetForTesting,
} from "../../tool-policies/context-budget.js";
import type { RestToolDefinition } from "../../mcp/types.js";

import { withConfig } from "../../__tests__/_utils/with-config.js";
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

// ── Pure truncation ─────────────────────────────────────────────────────────

describe("truncateToBudget (pure)", () => {
  test("returns text unchanged when already within budget", () => {
    const result = truncateToBudget("hello", 100);
    expect(result).toEqual({ text: "hello", truncated: false, originalBytes: 5, keptBytes: 5 });
  });

  test("cuts ASCII text at the exact byte boundary and appends a deterministic marker", () => {
    const text = "0123456789";
    const result = truncateToBudget(text, 4);
    expect(result.truncated).toBe(true);
    expect(result.originalBytes).toBe(10);
    expect(result.keptBytes).toBe(4);
    expect(result.text.startsWith("0123")).toBe(true);
    expect(result.text).toContain("kept 4 of 10 bytes");
    expect(result.text).toContain("6 byte(s) omitted");
    expect(result.text).toContain("4-byte limit");
  });

  test("never splits a multi-byte UTF-8 character — backs off to the nearest valid boundary", () => {
    // "é" is 2 bytes (0xC3 0xA9) in UTF-8. Cutting at an odd byte count would
    // land mid-sequence if handled naively.
    const text = "aé"; // 'a' (1 byte) + 'é' (2 bytes) = 3 bytes total
    const result = truncateToBudget(text, 2); // would split the 'é' sequence at byte 2
    expect(result.keptBytes).toBe(1); // backs off to just "a"
    expect(result.text.startsWith("a")).toBe(true);
    // The kept prefix must itself be valid UTF-8 (no replacement characters).
    expect(result.text.slice(0, 1)).not.toContain("�");
  });

  test("marker byte count matches an independent UTF-8 byte-length computation", () => {
    const text = "x".repeat(1000);
    const result = truncateToBudget(text, 100);
    expect(byteLength(result.text.slice(0, 100))).toBe(100);
    expect(result.originalBytes).toBe(1000);
  });
});

// ── setToolContextBudget / getToolContextBudget store round trip ───────────

describe("setToolContextBudget / getToolContextBudget", () => {
  test("unknown tool -> TOOL_NOT_FOUND", async () => {
    await reg();
    expect(await setToolContextBudget(CLIENT, "ghost", { mode: "truncate", maxResponseBytes: 1000 })).toMatchObject({
      ok: false,
      error: "TOOL_NOT_FOUND",
    });
  });

  test("truncate mode round-trips with no llm secret involved", async () => {
    await reg();
    expect(await setToolContextBudget(CLIENT, getTool.name, { mode: "truncate", maxResponseBytes: 500 })).toEqual({
      ok: true,
    });
    expect(registry.getClientDetail(CLIENT)!.tools[0].contextBudget).toEqual({
      mode: "truncate",
      maxResponseBytes: 500,
      llm: null,
    });
    expect(await setToolContextBudget(CLIENT, getTool.name, null)).toEqual({ ok: true });
    expect(registry.getClientDetail(CLIENT)!.tools[0].contextBudget).toBeUndefined();
  });

  test("llm_summarize mode requires a configured secrets provider, and never echoes the raw key back", async () => {
    await reg();
    expect(
      await setToolContextBudget(CLIENT, getTool.name, {
        mode: "llm_summarize",
        maxResponseBytes: 500,
        llm: { provider: "openai", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini", apiKey: "sk-raw-key" },
      }),
    ).toMatchObject({ ok: false, error: "SECRETS_PROVIDER_UNCONFIGURED" });

    configureSecretBox();
    expect(
      await setToolContextBudget(CLIENT, getTool.name, {
        mode: "llm_summarize",
        maxResponseBytes: 500,
        llm: { provider: "openai", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini", apiKey: "sk-raw-key" },
      }),
    ).toEqual({ ok: true });

    const pub = registry.getClientDetail(CLIENT)!.tools[0].contextBudget;
    expect(pub).toEqual({
      mode: "llm_summarize",
      maxResponseBytes: 500,
      llm: { provider: "openai", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini" },
    });
    // The public read-model must never carry the raw key or its encrypted ref.
    expect(JSON.stringify(pub)).not.toContain("sk-raw-key");

    // The internal (proxy-side) read carries only the encrypted ref, never the raw key.
    const internal = getToolContextBudget(CLIENT, getTool.name);
    expect(internal?.llm?.apiKeyRef).toBeTruthy();
    expect(internal?.llm?.apiKeyRef).not.toBe("sk-raw-key");
  });
});

// ── applyContextBudget: zero-config default, truncate mode ─────────────────

describe("applyContextBudget", () => {
  test("no configured budget -> text passes through unchanged (today's behavior)", async () => {
    await reg();
    const result = await applyContextBudget(CLIENT, getTool.name, `${CLIENT}__${getTool.name}`, "x".repeat(10_000));
    expect(result).toEqual({ text: "x".repeat(10_000), applied: "none" });
  });

  test("under budget -> unchanged even when a budget is configured", async () => {
    await reg();
    await setToolContextBudget(CLIENT, getTool.name, { mode: "truncate", maxResponseBytes: 10_000 });
    const result = await applyContextBudget(CLIENT, getTool.name, `${CLIENT}__${getTool.name}`, "short");
    expect(result).toEqual({ text: "short", applied: "none" });
  });

  test("over budget in truncate mode -> deterministic truncation, no fetch call made", async () => {
    await reg();
    await setToolContextBudget(CLIENT, getTool.name, { mode: "truncate", maxResponseBytes: 10 });
    let fetchCalled = false;
    __setContextBudgetFetchForTesting((async () => {
      fetchCalled = true;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch);
    const result = await applyContextBudget(CLIENT, getTool.name, `${CLIENT}__${getTool.name}`, "0123456789ABCDEF");
    expect(result.applied).toBe("truncate");
    expect(result.text).toContain("kept 10 of 16 bytes");
    expect(fetchCalled).toBe(false);
  });
});

// ── llm_summarize: mocked-fetch request shapes for both providers ──────────

describe("applyContextBudget — llm_summarize request shapes (mocked fetch)", () => {
  test("openai provider: POST {base}/chat/completions with Bearer auth and a messages array", async () => {
    await reg();
    configureSecretBox();
    await setToolContextBudget(CLIENT, getTool.name, {
      mode: "llm_summarize",
      maxResponseBytes: 20,
      llm: { provider: "openai", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini", apiKey: "sk-secret-123" },
    });

    let seenUrl = "";
    let seenAuth: string | undefined;
    let seenBody: Record<string, unknown> = {};
    __setContextBudgetFetchForTesting((async (url: string, init: RequestInit) => {
      seenUrl = String(url);
      seenAuth = new Headers(init.headers).get("authorization") ?? undefined;
      seenBody = JSON.parse(init.body as string) as Record<string, unknown>;
      return new Response(JSON.stringify({ choices: [{ message: { content: "compressed summary" } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch);

    const longText = "y".repeat(500);
    const result = await applyContextBudget(CLIENT, getTool.name, `${CLIENT}__${getTool.name}`, longText);

    expect(result).toEqual({ text: "compressed summary", applied: "llm_summarize" });
    expect(seenUrl).toBe("https://api.openai.com/v1/chat/completions");
    expect(seenAuth).toBe("Bearer sk-secret-123");
    expect(seenBody.model).toBe("gpt-4o-mini");
    const messages = seenBody.messages as Array<{ role: string; content: string }>;
    expect(messages[0].role).toBe("system");
    expect(messages[1].role).toBe("user");
    expect(messages[1].content).toContain(longText);
  });

  test("anthropic provider: POST {base}/v1/messages with x-api-key + anthropic-version and a system+user shape", async () => {
    await reg();
    configureSecretBox();
    await setToolContextBudget(CLIENT, getTool.name, {
      mode: "llm_summarize",
      maxResponseBytes: 20,
      llm: {
        provider: "anthropic",
        baseUrl: "https://api.anthropic.com",
        model: "claude-haiku-4-5",
        apiKey: "anthropic-secret-456",
      },
    });

    let seenUrl = "";
    let seenApiKeyHeader: string | undefined;
    let seenVersionHeader: string | undefined;
    let seenBody: Record<string, unknown> = {};
    __setContextBudgetFetchForTesting((async (url: string, init: RequestInit) => {
      seenUrl = String(url);
      const headers = new Headers(init.headers);
      seenApiKeyHeader = headers.get("x-api-key") ?? undefined;
      seenVersionHeader = headers.get("anthropic-version") ?? undefined;
      seenBody = JSON.parse(init.body as string) as Record<string, unknown>;
      return new Response(JSON.stringify({ content: [{ type: "text", text: "anthropic summary" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch);

    const longText = "z".repeat(500);
    const result = await applyContextBudget(CLIENT, getTool.name, `${CLIENT}__${getTool.name}`, longText);

    expect(result).toEqual({ text: "anthropic summary", applied: "llm_summarize" });
    expect(seenUrl).toBe("https://api.anthropic.com/v1/messages");
    expect(seenApiKeyHeader).toBe("anthropic-secret-456");
    expect(seenVersionHeader).toBe("2023-06-01");
    expect(seenBody.model).toBe("claude-haiku-4-5");
    expect(typeof seenBody.max_tokens).toBe("number");
    expect(seenBody.system).toContain("compress");
    const messages = seenBody.messages as Array<{ role: string; content: string }>;
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("user");
    expect(messages[0].content).toContain(longText);
  });
});

// ── Fall back to deterministic truncation on ANY LLM failure ───────────────

describe("applyContextBudget — falls back to truncate on LLM failure", () => {
  async function configureLlmBudget(maxResponseBytes: number): Promise<void> {
    await reg();
    configureSecretBox();
    await setToolContextBudget(CLIENT, getTool.name, {
      mode: "llm_summarize",
      maxResponseBytes,
      llm: { provider: "openai", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini", apiKey: "sk-x" },
    });
  }

  test("non-2xx response -> falls back to truncate, never throws", async () => {
    await configureLlmBudget(10);
    __setContextBudgetFetchForTesting(
      (async () => new Response("rate limited", { status: 429 })) as unknown as typeof fetch,
    );
    const result = await applyContextBudget(CLIENT, getTool.name, `${CLIENT}__${getTool.name}`, "0123456789ABCDEF");
    expect(result.applied).toBe("llm_summarize_fallback_truncate");
    expect(result.text).toContain("kept 10 of 16 bytes");
  });

  test("network error -> falls back to truncate, never throws", async () => {
    await configureLlmBudget(10);
    __setContextBudgetFetchForTesting((async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch);
    const result = await applyContextBudget(CLIENT, getTool.name, `${CLIENT}__${getTool.name}`, "0123456789ABCDEF");
    expect(result.applied).toBe("llm_summarize_fallback_truncate");
  });

  test("malformed JSON response body -> falls back to truncate, never throws", async () => {
    await configureLlmBudget(10);
    __setContextBudgetFetchForTesting(
      (async () => new Response("not json", { status: 200 })) as unknown as typeof fetch,
    );
    const result = await applyContextBudget(CLIENT, getTool.name, `${CLIENT}__${getTool.name}`, "0123456789ABCDEF");
    expect(result.applied).toBe("llm_summarize_fallback_truncate");
  });

  test("response missing the expected content field -> falls back to truncate, never throws", async () => {
    await configureLlmBudget(10);
    __setContextBudgetFetchForTesting((async () =>
      Response.json({ choices: [{ message: {} }] })) as unknown as typeof fetch);
    const result = await applyContextBudget(CLIENT, getTool.name, `${CLIENT}__${getTool.name}`, "0123456789ABCDEF");
    expect(result.applied).toBe("llm_summarize_fallback_truncate");
  });

  test("a slow LLM call times out and falls back to truncate rather than hanging the tool call", async () => {
    await withConfig({ contextBudgetLlmTimeoutMs: 50 }, async () => {
      await configureLlmBudget(10);
      __setContextBudgetFetchForTesting((async (_url: string, init: RequestInit) => {
        return new Promise<Response>((resolve, reject) => {
          const t = setTimeout(() => resolve(new Response("{}", { status: 200 })), 5_000);
          init.signal?.addEventListener("abort", () => {
            clearTimeout(t);
            reject(new Error("aborted"));
          });
        });
      }) as unknown as typeof fetch);
      const start = Date.now();
      const result = await applyContextBudget(CLIENT, getTool.name, `${CLIENT}__${getTool.name}`, "0123456789ABCDEF");
      expect(Date.now() - start).toBeLessThan(4_000);
      expect(result.applied).toBe("llm_summarize_fallback_truncate");
    });
  });
});

// ── Integration: proxyToolCall — budget only ever sees POST-redaction data ─

describe("proxy integration — ordering (security-critical)", () => {
  test("REST path: the LLM summarizer only ever sees the already-redacted body, never the raw secret", async () => {
    await reg();
    setRedactionPaths(CLIENT, getTool.name, ["apiSecret"]);
    configureSecretBox();
    // A tiny budget forces summarization even though the (redacted) body is
    // small — but still comfortably >= the mocked "summary" response below,
    // so this test isolates redaction ordering rather than the separate
    // still-oversized-summary truncation path.
    await setToolContextBudget(CLIENT, getTool.name, {
      mode: "llm_summarize",
      maxResponseBytes: 20,
      llm: { provider: "openai", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini", apiKey: "sk-x" },
    });

    const RAW_SECRET = "sk-live-super-secret-upstream-token";
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ user: "alice", apiSecret: RAW_SECRET }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;

    let capturedPrompt = "";
    __setContextBudgetFetchForTesting((async (_url: string, init: RequestInit) => {
      capturedPrompt = init.body as string;
      return new Response(JSON.stringify({ choices: [{ message: { content: "summary" } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch);

    const res = await proxyToolCall(`${CLIENT}__${getTool.name}`, {});

    // The assertion that would fail if enforcement ran BEFORE redaction:
    expect(capturedPrompt).not.toContain(RAW_SECRET);
    expect(capturedPrompt).toContain("[REDACTED]");
    expect(res.content[0].text).toBe("summary");
  });

  test("REST path: falling back to truncate after a redacted body also never leaks the raw secret", async () => {
    await reg();
    setRedactionPaths(CLIENT, getTool.name, ["apiSecret"]);
    configureSecretBox();
    await setToolContextBudget(CLIENT, getTool.name, {
      mode: "llm_summarize",
      // Large enough to keep the "[REDACTED]" marker in the truncated output, but
      // still smaller than the full redacted body so truncation actually kicks in.
      maxResponseBytes: 46,
      llm: { provider: "openai", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini", apiKey: "sk-x" },
    });

    const RAW_SECRET = "sk-live-another-secret-value";
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ user: "bob", apiSecret: RAW_SECRET }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;

    __setContextBudgetFetchForTesting((async () => new Response("boom", { status: 500 })) as unknown as typeof fetch);

    const res = await proxyToolCall(`${CLIENT}__${getTool.name}`, {});
    expect(res.content[0].text).not.toContain(RAW_SECRET);
    expect(res.content[0].text).toContain("[REDACTED]");
    expect(res.content[0].text).toContain("context-budget: response truncated");
  });

  test("no configured budget: response is returned unbounded, exactly as before this feature", async () => {
    await reg();
    const bigBody = JSON.stringify({ data: "x".repeat(50_000) });
    globalThis.fetch = (async () =>
      new Response(bigBody, {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    const res = await proxyToolCall(`${CLIENT}__${getTool.name}`, {});
    expect(JSON.parse(res.content[0].text ?? "").data).toBe("x".repeat(50_000));
  });
});

// ── Admin route (PATCH folded into the shared tools handler) ───────────────

describe("admin route", () => {
  const ADMIN_KEY = "test-admin-key";
  let baseUrl = "";
  let server: Server | null = null;

  async function startApp(): Promise<void> {
    (config as Record<string, unknown>).adminApiKeys = [ADMIN_KEY];
    (config as Record<string, unknown>).authDisabled = false;
    const { adminRoutes } = await import("../../routes/admin.js");
    const app = express();
    app.use(express.json());
    app.use(requestIdMiddleware);
    adminRoutes(app);
    await new Promise<void>((resolve) => {
      const srv = app.listen(0, "127.0.0.1", () => {
        baseUrl = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
        server = srv;
        resolve();
      });
    });
  }

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      if (server)
        server.close(() => {
          server = null;
          resolve();
        });
      else resolve();
    });
  });

  test("PATCH truncate mode sets the config, exposed on client detail without any llm block", async () => {
    await reg();
    await startApp();
    const res = await fetch(`${baseUrl}/admin-api/clients/${CLIENT}/tools/${getTool.name}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${ADMIN_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ contextBudget: { mode: "truncate", maxResponseBytes: 4096 } }),
    });
    expect(res.status).toBe(200);
    expect(registry.getClientDetail(CLIENT)!.tools[0].contextBudget).toEqual({
      mode: "truncate",
      maxResponseBytes: 4096,
      llm: null,
    });
  });

  test("PATCH llm_summarize without a configured secrets provider is rejected with 400, nothing persisted", async () => {
    await reg();
    await startApp();
    const res = await fetch(`${baseUrl}/admin-api/clients/${CLIENT}/tools/${getTool.name}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${ADMIN_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        contextBudget: {
          mode: "llm_summarize",
          maxResponseBytes: 4096,
          llm: { provider: "openai", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini", apiKey: "sk-x" },
        },
      }),
    });
    expect(res.status).toBe(400);
    expect(registry.getClientDetail(CLIENT)!.tools[0].contextBudget).toBeUndefined();
  });

  test("PATCH llm_summarize persists an encrypted ref, never the raw key, and clearing removes it", async () => {
    await reg();
    configureSecretBox();
    await startApp();
    const res = await fetch(`${baseUrl}/admin-api/clients/${CLIENT}/tools/${getTool.name}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${ADMIN_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        contextBudget: {
          mode: "llm_summarize",
          maxResponseBytes: 4096,
          llm: {
            provider: "anthropic",
            baseUrl: "https://api.anthropic.com",
            model: "claude-haiku-4-5",
            apiKey: "raw-anthropic-key-should-never-be-stored-as-is",
          },
        },
      }),
    });
    expect(res.status).toBe(200);
    const detail = registry.getClientDetail(CLIENT)!.tools[0].contextBudget;
    expect(detail).toEqual({
      mode: "llm_summarize",
      maxResponseBytes: 4096,
      llm: { provider: "anthropic", baseUrl: "https://api.anthropic.com", model: "claude-haiku-4-5" },
    });
    expect(JSON.stringify(detail)).not.toContain("raw-anthropic-key-should-never-be-stored-as-is");

    const clearRes = await fetch(`${baseUrl}/admin-api/clients/${CLIENT}/tools/${getTool.name}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${ADMIN_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ contextBudget: null }),
    });
    expect(clearRes.status).toBe(200);
    expect(registry.getClientDetail(CLIENT)!.tools[0].contextBudget).toBeUndefined();
  });

  test("PATCH rejects an out-of-range maxResponseBytes with 400", async () => {
    await reg();
    await startApp();
    const res = await fetch(`${baseUrl}/admin-api/clients/${CLIENT}/tools/${getTool.name}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${ADMIN_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ contextBudget: { mode: "truncate", maxResponseBytes: 10 } }),
    });
    expect(res.status).toBe(400);
  });
});
