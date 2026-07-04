/**
 * Auto-pagination — pure helpers, config persistence, and proxy integration for
 * the cursor / page / link strategies, including the maxPages bound and the
 * SSRF-safe refusal to follow a cross-host `link` next URL.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { config } from "../config.js";
import { __resetDbForTesting } from "../db/connection.js";
import { registry } from "../mcp/registry.js";
import { removeCircuitBreaker } from "../circuit-breaker.js";
import { proxyToolCall } from "../proxy.js";
import {
  getPaginationConfig,
  setPaginationConfig,
  getByPath,
  extractItems,
  nextCursorValue,
  parseNextLink,
  withItems,
} from "../pagination.js";
import type { RestToolDefinition } from "../mcp/types.js";

const CLIENT = "svc";
const listTool: RestToolDefinition = {
  name: "get-list",
  method: "GET",
  endpoint: "/list",
  description: "list",
  inputSchema: { type: "object", properties: {} },
};
async function reg(): Promise<void> {
  await registry.register(CLIENT, [listTool], "http://1.2.3.4/health", "1.2.3.4", "http://1.2.3.4", "1.2.3.4");
}
function json(body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", ...headers },
  });
}

const originalFetch = globalThis.fetch;
function resetAll(): void {
  (config as Record<string, unknown>).retryMaxAttempts = 0;
  __resetDbForTesting();
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

describe("pure helpers", () => {
  test("getByPath / extractItems", () => {
    expect(getByPath({ a: { b: 1 } }, "a.b")).toBe(1);
    expect(getByPath({ a: 1 }, "")).toEqual({ a: 1 });
    expect(getByPath({ a: 1 }, "x.y")).toBeUndefined();
    expect(extractItems({ data: [1, 2] }, "data")).toEqual([1, 2]);
    expect(extractItems({ data: "no" }, "data")).toBeNull();
    expect(extractItems([1, 2], "")).toEqual([1, 2]);
  });

  test("nextCursorValue coerces / stops", () => {
    expect(nextCursorValue({ n: "c1" }, "n")).toBe("c1");
    expect(nextCursorValue({ n: 42 }, "n")).toBe("42");
    expect(nextCursorValue({ n: "" }, "n")).toBeNull();
    expect(nextCursorValue({ n: null }, "n")).toBeNull();
    expect(nextCursorValue({}, "n")).toBeNull();
  });

  test("parseNextLink picks rel=next", () => {
    expect(parseNextLink('<https://api/x?page=2>; rel="next", <https://api/x?page=9>; rel="last"')).toBe(
      "https://api/x?page=2",
    );
    expect(parseNextLink('<https://api/x?page=9>; rel="last"')).toBeNull();
    expect(parseNextLink(null)).toBeNull();
  });

  test("withItems replaces the array, cloning", () => {
    const body = { data: [1], meta: { x: 1 } };
    const out = withItems(body, "data", [1, 2, 3]) as { data: number[]; meta: { x: number } };
    expect(out.data).toEqual([1, 2, 3]);
    expect(out.meta).toEqual({ x: 1 });
    expect(body.data).toEqual([1]); // original untouched
    expect(withItems([1], "", [1, 2])).toEqual([1, 2]);
  });
});

describe("config persistence", () => {
  test("unknown tool -> false; set/get; clear", async () => {
    await reg();
    expect(
      setPaginationConfig(CLIENT, "nope", {
        enabled: true,
        strategy: "page",
        itemsPath: "items",
        pageParam: "page",
        maxPages: 5,
      }),
    ).toBe(false);
    expect(
      setPaginationConfig(CLIENT, "get-list", {
        enabled: true,
        strategy: "cursor",
        itemsPath: "data",
        cursorResponsePath: "next",
        cursorParam: "cursor",
        maxPages: 5,
      }),
    ).toBe(true);
    expect(getPaginationConfig(CLIENT, "get-list")).toMatchObject({
      enabled: true,
      strategy: "cursor",
      itemsPath: "data",
      cursorResponsePath: "next",
      cursorParam: "cursor",
      maxPages: 5,
    });
    expect(setPaginationConfig(CLIENT, "get-list", null)).toBe(true);
    expect(getPaginationConfig(CLIENT, "get-list")).toBeNull();
  });
});

describe("proxy integration", () => {
  test("cursor strategy aggregates pages until the cursor is null", async () => {
    await reg();
    setPaginationConfig(CLIENT, "get-list", {
      enabled: true,
      strategy: "cursor",
      itemsPath: "data",
      cursorResponsePath: "next",
      cursorParam: "cursor",
      maxPages: 10,
    });
    let calls = 0;
    globalThis.fetch = (async (url: string) => {
      calls++;
      const c = new URL(String(url)).searchParams.get("cursor");
      if (!c) return json({ data: [1, 2], next: "c1" });
      if (c === "c1") return json({ data: [3, 4], next: "c2" });
      return json({ data: [5], next: null });
    }) as unknown as typeof fetch;
    const r = await proxyToolCall(`${CLIENT}__get-list`, {});
    expect(JSON.parse(r.content[0].text).data).toEqual([1, 2, 3, 4, 5]);
    expect(calls).toBe(3);
  });

  test("page strategy aggregates until an empty page", async () => {
    await reg();
    setPaginationConfig(CLIENT, "get-list", {
      enabled: true,
      strategy: "page",
      itemsPath: "items",
      pageParam: "page",
      maxPages: 10,
    });
    let calls = 0;
    globalThis.fetch = (async (url: string) => {
      calls++;
      const p = new URL(String(url)).searchParams.get("page");
      if (!p) return json({ items: [1, 2] });
      if (p === "2") return json({ items: [3] });
      return json({ items: [] });
    }) as unknown as typeof fetch;
    const r = await proxyToolCall(`${CLIENT}__get-list`, {});
    expect(JSON.parse(r.content[0].text).items).toEqual([1, 2, 3]);
    expect(calls).toBe(3);
  });

  test("link strategy follows rel=next on the same host", async () => {
    await reg();
    setPaginationConfig(CLIENT, "get-list", { enabled: true, strategy: "link", itemsPath: "", maxPages: 10 });
    let calls = 0;
    globalThis.fetch = (async (url: string) => {
      calls++;
      const p = new URL(String(url)).searchParams.get("page");
      if (!p) return json([1, 2], { link: '<http://1.2.3.4/list?page=2>; rel="next"' });
      if (p === "2") return json([3, 4], { link: '<http://1.2.3.4/list?page=3>; rel="next"' });
      return json([5]);
    }) as unknown as typeof fetch;
    const r = await proxyToolCall(`${CLIENT}__get-list`, {});
    expect(JSON.parse(r.content[0].text)).toEqual([1, 2, 3, 4, 5]);
    expect(calls).toBe(3);
  });

  test("a cross-host link next URL is NOT followed (SSRF-safe)", async () => {
    await reg();
    setPaginationConfig(CLIENT, "get-list", { enabled: true, strategy: "link", itemsPath: "", maxPages: 10 });
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return json([1, 2], { link: '<http://9.9.9.9/list?page=2>; rel="next"' });
    }) as unknown as typeof fetch;
    const r = await proxyToolCall(`${CLIENT}__get-list`, {});
    expect(JSON.parse(r.content[0].text)).toEqual([1, 2]);
    expect(calls).toBe(1);
  });

  test("maxPages bounds the number of pages fetched", async () => {
    await reg();
    setPaginationConfig(CLIENT, "get-list", {
      enabled: true,
      strategy: "cursor",
      itemsPath: "data",
      cursorResponsePath: "next",
      cursorParam: "cursor",
      maxPages: 2,
    });
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return json({ data: [calls], next: `c${calls}` }); // never-ending cursor
    }) as unknown as typeof fetch;
    await proxyToolCall(`${CLIENT}__get-list`, {});
    expect(calls).toBe(2); // primary page + 1 follow-up, capped by maxPages=2
  });
});
