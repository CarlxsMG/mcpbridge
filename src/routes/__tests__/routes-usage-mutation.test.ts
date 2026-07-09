/**
 * Stryker mutation-testing backstop for src/routes/usage.ts — domain 8.
 * Baseline: 28 mutants, 16 killed / 12 survived — the existing
 * routes-usage.test.ts only covers the happy path (no filters, no
 * narrowing). All line:col citations below were read directly from
 * reports/mutation/result.json.
 *
 * One survivor is an accepted EQUIVALENT mutant, not chased with a
 * dedicated test: 6:7-28 ConditionalExpression 'false' (the `num()`
 * helper's `typeof v !== "string"` guard forced to never trigger).
 * Verified empirically (see /tmp/qtest.mjs-style probe against a real
 * Express app): under Express's default query parser, `req.query.x` can
 * only ever be a `string`, a `string[]` (via a repeated key), or
 * `undefined` — never a bare object. `Number(undefined)` is `NaN`, and
 * `Number(arr)` for any reachable `string[]` is also always `NaN` (a
 * multi-element array stringifies via a comma-joined `Array.prototype
 * .toString()`, and no reachable comma-joined combination of query-string
 * values happens to parse as a clean numeral — a single occurrence never
 * becomes an array in the first place, so there's no way to reach a
 * single-element array either). Since `Number.isFinite(NaN)` is always
 * false, both the real early-return and the "always false" mutant's
 * fall-through to `Number(v)` produce the identical result (`undefined`)
 * for every input actually reachable over HTTP.
 */
import { describe, test, expect } from "bun:test";
import express from "express";
import type { AddressInfo } from "net";
import type { Server } from "http";
import { config } from "../../config.js";
import { __resetDbForTesting } from "../../db/connection.js";
import { requestIdMiddleware } from "../../middleware/request-id.js";
import { recordUsage } from "../../observability/usage.js";

const ADMIN_KEY = "test-admin-key-usage-mut";

async function startApp(): Promise<{ baseUrl: string; server: Server }> {
  __resetDbForTesting();
  (config as Record<string, unknown>).adminApiKeys = [ADMIN_KEY];
  (config as Record<string, unknown>).authDisabled = false;
  const { usageRoutes } = await import("../../routes/usage.js");
  const app = express();
  app.use(express.json());
  app.use(requestIdMiddleware);
  usageRoutes(app);
  return new Promise((resolve, reject) => {
    const srv = app.listen(0, "127.0.0.1", () => {
      resolve({ baseUrl: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`, server: srv });
    });
    srv.on("error", reject);
  });
}

function bearer(): Record<string, string> {
  return { Authorization: `Bearer ${ADMIN_KEY}` };
}

async function withApp(fn: (baseUrl: string) => Promise<void>): Promise<void> {
  const { baseUrl, server } = await startApp();
  try {
    await fn(baseUrl);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe("GET /admin-api/usage/summary — from filter and client filter", () => {
  // Kills 15:23-19:8 ObjectLiteral (the whole opts argument to
  // getUsageSummary emptied to {} -- the from filter would silently stop
  // narrowing, always using the full default 7-day window).
  test("a far-future ?from= excludes every already-recorded call", async () => {
    await withApp(async (baseUrl) => {
      recordUsage({ clientName: "svc", toolName: "a", keyId: null, statusClass: "2xx", isError: false, durationMs: 5 });
      const farFuture = Date.now() + 10_000_000;
      const res = await fetch(`${baseUrl}/admin-api/usage/summary?from=${farFuture}`, { headers: bearer() });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { calls: number };
      expect(body.calls).toBe(0);
    });
  });

  // Kills 18:21-57 ConditionalExpression 'false' and StringLiteral '""'
  // and EqualityOperator '!==' (all three invert the client filter to
  // effectively "never apply it for a real string value"). A 2-client
  // fixture with the filter applied to only ONE of them distinguishes
  // this: real code narrows to that client's calls alone; any of the
  // three mutants would count both clients' calls instead.
  test("?client=<name> narrows the summary to that client's calls alone", async () => {
    await withApp(async (baseUrl) => {
      recordUsage({
        clientName: "svc-x",
        toolName: "a",
        keyId: null,
        statusClass: "2xx",
        isError: false,
        durationMs: 5,
      });
      recordUsage({
        clientName: "svc-y",
        toolName: "a",
        keyId: null,
        statusClass: "2xx",
        isError: false,
        durationMs: 5,
      });
      recordUsage({
        clientName: "svc-y",
        toolName: "a",
        keyId: null,
        statusClass: "2xx",
        isError: false,
        durationMs: 5,
      });
      const res = await fetch(`${baseUrl}/admin-api/usage/summary?client=svc-x`, { headers: bearer() });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { calls: number };
      expect(body.calls).toBe(1);
    });
  });

  // Kills 18:21-57 ConditionalExpression 'true' (forces the ternary to
  // always pass req.query.client through verbatim, even when it's a
  // non-string array from a repeated key). bun:sqlite throws
  // synchronously when a plain array is bound as a query parameter
  // ("Binding expected string, TypedArray, boolean, number, bigint or
  // null", verified empirically), which Express's default error handler
  // turns into a 500 -- real code drops the non-string value and never
  // reaches that bind call, staying 200.
  test("a non-string ?client value (repeated query key) doesn't crash the request", async () => {
    await withApp(async (baseUrl) => {
      recordUsage({ clientName: "svc", toolName: "a", keyId: null, statusClass: "2xx", isError: false, durationMs: 5 });
      const res = await fetch(`${baseUrl}/admin-api/usage/summary?client=a&client=b`, { headers: bearer() });
      expect(res.status).toBe(200);
    });
  });
});

describe("GET /admin-api/usage/timeseries — client filter", () => {
  // Kills 29:21-57's identical 3-mutant cluster (ConditionalExpression
  // 'false', StringLiteral '""', EqualityOperator '!==') via the same
  // 2-client narrowing technique used for /summary above.
  test("?client=<name> narrows the timeseries to that client's calls alone", async () => {
    await withApp(async (baseUrl) => {
      recordUsage({
        clientName: "svc-x",
        toolName: "a",
        keyId: null,
        statusClass: "2xx",
        isError: false,
        durationMs: 5,
      });
      recordUsage({
        clientName: "svc-y",
        toolName: "a",
        keyId: null,
        statusClass: "2xx",
        isError: false,
        durationMs: 5,
      });
      const res = await fetch(`${baseUrl}/admin-api/usage/timeseries?client=svc-x&bucketMs=3600000`, {
        headers: bearer(),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { points: { calls: number }[] };
      expect(body.points.reduce((sum, p) => sum + p.calls, 0)).toBe(1);
    });
  });

  // Kills 29:21-57 ConditionalExpression 'true', same reasoning/technique
  // as the /summary case above.
  test("a non-string ?client value (repeated query key) doesn't crash the request", async () => {
    await withApp(async (baseUrl) => {
      recordUsage({ clientName: "svc", toolName: "a", keyId: null, statusClass: "2xx", isError: false, durationMs: 5 });
      const res = await fetch(`${baseUrl}/admin-api/usage/timeseries?client=a&client=b`, { headers: bearer() });
      expect(res.status).toBe(200);
    });
  });
});

describe("GET /admin-api/usage/top-tools — limit narrows results", () => {
  // Kills 35:47-105 ObjectLiteral (the { from, limit } argument to
  // getTopTools emptied to {} -- limit would silently fall back to its
  // default of 20 instead of the requested value).
  test("?limit=1 returns exactly one tool even with two recorded", async () => {
    await withApp(async (baseUrl) => {
      recordUsage({ clientName: "svc", toolName: "a", keyId: null, statusClass: "2xx", isError: false, durationMs: 5 });
      recordUsage({ clientName: "svc", toolName: "b", keyId: null, statusClass: "2xx", isError: false, durationMs: 5 });
      const res = await fetch(`${baseUrl}/admin-api/usage/top-tools?limit=1`, { headers: bearer() });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { items: unknown[] };
      expect(body.items).toHaveLength(1);
    });
  });
});

describe("GET /admin-api/usage/by-key — limit narrows results", () => {
  // Kills 39:49-107 ObjectLiteral (the { from, limit } argument to
  // getUsageByKey emptied to {} -- limit would silently fall back to its
  // default of 50 instead of the requested value).
  test("?limit=1 returns exactly one key even with two recorded", async () => {
    await withApp(async (baseUrl) => {
      recordUsage({ clientName: "svc", toolName: "a", keyId: 1, statusClass: "2xx", isError: false, durationMs: 5 });
      recordUsage({ clientName: "svc", toolName: "a", keyId: 2, statusClass: "2xx", isError: false, durationMs: 5 });
      const res = await fetch(`${baseUrl}/admin-api/usage/by-key?limit=1`, { headers: bearer() });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { items: unknown[] };
      expect(body.items).toHaveLength(1);
    });
  });
});
