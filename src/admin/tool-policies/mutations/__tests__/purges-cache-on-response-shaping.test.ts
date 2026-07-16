/**
 * Regression test for finding #4 (P1): editing a response-shaping policy
 * (redactPaths / guardrails / transform / streaming / pagination /
 * contextBudget) must purge the tool's response cache, so a body cached under
 * the OLD policy can't keep serving newly-redacted secrets until MAX_CACHE_TTL
 * lapses. Non-shaping mutations (e.g. `enabled`) must NOT purge.
 *
 * Exercised through DIRECT `dispatchToolMutations` calls (no Express app),
 * matching the sibling mutations-batch.test.ts convention.
 */
import { describe, test, expect } from "bun:test";
import type { Response } from "express";
import { __resetDbForTesting } from "../../../../db/connection.js";
import { registry } from "../../../../mcp/registry.js";
import { cacheKey, cacheGet, cacheSet, __resetCacheForTesting } from "../../../../tool-policies/response-cache.js";
import { dispatchToolMutations } from "../index.js";

const CLIENT = "cache-purge-svc";
const TOOL = "get-x";
const BASE_URL = "http://example.com";

async function reg(): Promise<void> {
  await registry.register(
    CLIENT,
    [
      {
        name: TOOL,
        method: "GET",
        endpoint: "/x",
        description: "d",
        inputSchema: { type: "object", properties: {} },
      },
    ],
    "http://example.com/health",
    "1.2.3.4",
    BASE_URL,
    "1.2.3.4",
  );
}

function mockRes(): Response {
  const res = {
    status() {
      return res;
    },
    json() {
      return res;
    },
  } as unknown as Response;
  return res;
}

function seedCacheEntry(): string {
  const key = cacheKey(CLIENT, TOOL, BASE_URL, {});
  cacheSet(key, { content: [{ type: "text", text: "old-secret" }] }, 3600);
  return key;
}

async function dispatch(body: Record<string, unknown>): Promise<void> {
  const outcome = await dispatchToolMutations(
    body,
    { actor: "test-actor", clientName: CLIENT, toolName: TOOL },
    mockRes(),
  );
  expect(outcome).toBeNull();
}

describe("response cache purge on response-shaping mutations", () => {
  test("editing redactPaths purges the tool's cached response", async () => {
    __resetDbForTesting();
    __resetCacheForTesting();
    await reg();
    const key = seedCacheEntry();
    expect(cacheGet(key)).not.toBeNull();

    await dispatch({ redactPaths: ["password"] });

    expect(cacheGet(key)).toBeNull();
  });

  test.each([
    ["guardrails", { denyPatterns: ["x"], blockSecrets: true, scanResponses: true }],
    ["transform", { request: [], response: [{ op: "remove", path: "secret" }] }],
    ["streaming", { format: "ndjson", maxEvents: 10 }],
    ["pagination", { strategy: "cursor", cursorResponsePath: "next", cursorParam: "cursor", maxPages: 3 }],
    ["contextBudget", { mode: "truncate", maxResponseBytes: 1000 }],
  ] as const)("editing %s purges the tool's cached response", async (key, value) => {
    __resetDbForTesting();
    __resetCacheForTesting();
    await reg();
    const cacheEntryKey = seedCacheEntry();
    expect(cacheGet(cacheEntryKey)).not.toBeNull();

    await dispatch({ [key]: value });

    expect(cacheGet(cacheEntryKey)).toBeNull();
  });

  test("a non-shaping mutation (enabled) does NOT purge the cache", async () => {
    __resetDbForTesting();
    __resetCacheForTesting();
    await reg();
    const key = seedCacheEntry();
    expect(cacheGet(key)).not.toBeNull();

    await dispatch({ enabled: false });

    expect(cacheGet(key)).not.toBeNull();
  });
});
