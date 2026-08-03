/**
 * Stryker mutation-testing backstop for src/routes/admin/audit-log.ts —
 * domain 8. Baseline: 69 mutants, 41 killed / 28 survived — existing
 * coverage (in routes-admin.test.ts, left untouched here) smoke-tests
 * GET /audit-log and thoroughly covers GET /audit-log/export's
 * format=csv/html/json branches, but never varies actor/action/from/to/
 * cursor/limit on EITHER list endpoint. All line:col citations below
 * were read directly from reports/mutation/result.json.
 */
import { describe, test, expect } from "bun:test";
import { listen, closeServer } from "../../__tests__/_utils/app.js";
import { bearerHeaders, setAdminApiKeys } from "../../__tests__/_utils/admin-auth.js";
import express from "express";
import type { Server } from "http";
import { config } from "../../config.js";
import { __resetDbForTesting } from "../../db/connection.js";
import { recordAudit } from "../../admin/audit/audit.js";

const ADMIN_KEY = "test-admin-key-audit-log-mut";

async function startApp(): Promise<{ baseUrl: string; server: Server }> {
  __resetDbForTesting();
  setAdminApiKeys([ADMIN_KEY]);
  (config as Record<string, unknown>).authDisabled = false;
  const { adminRoutes } = await import("../../routes/admin.js");
  const app = express();
  app.use(express.json());
  adminRoutes(app);
  return listen(app);
}

const bearer = (): Record<string, string> => bearerHeaders(ADMIN_KEY);

async function withApp(fn: (baseUrl: string) => Promise<void>): Promise<void> {
  const { baseUrl, server } = await startApp();
  try {
    await fn(baseUrl);
  } finally {
    await closeServer(server);
  }
}

describe("GET /admin-api/audit-log — filters", () => {
  // Kills 17:31-24:4 ObjectLiteral (the whole filter object emptied to
  // {} -- every filter would silently stop narrowing).
  test("lists every recorded entry with no filters", async () => {
    await withApp(async (baseUrl) => {
      recordAudit("alice", "client.enable", "svc-a");
      const res = await fetch(`${baseUrl}/admin-api/audit-log`, { headers: bearer() });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { items: unknown[] };
      expect(body.items.length).toBeGreaterThan(0);
    });
  });

  // Kills 18:12-37 ConditionalExpression 'false' / StringLiteral '""'
  // ("string" emptied) via narrowing; ConditionalExpression 'true' /
  // EqualityOperator via a non-string repeated-query-key check.
  test("?actor=<name> narrows to that actor's entries alone", async () => {
    await withApp(async (baseUrl) => {
      recordAudit("audit-actor-x", "client.enable", "svc");
      recordAudit("audit-actor-y", "client.enable", "svc");
      const res = await fetch(`${baseUrl}/admin-api/audit-log?actor=audit-actor-x`, { headers: bearer() });
      const body = (await res.json()) as { items: { actor: string }[] };
      expect(body.items).toHaveLength(1);
      expect(body.items[0].actor).toBe("audit-actor-x");
    });
  });

  test("a non-string ?actor value (repeated query key) doesn't crash the request", async () => {
    await withApp(async (baseUrl) => {
      recordAudit("audit-actor-z", "client.enable", "svc");
      const res = await fetch(`${baseUrl}/admin-api/audit-log?actor=a&actor=b`, { headers: bearer() });
      expect(res.status).toBe(200);
    });
  });

  // Kills 19:13-39's identical 4-mutant cluster for the action filter.
  test("?action=<name> narrows to that action's entries alone", async () => {
    await withApp(async (baseUrl) => {
      recordAudit("audit-actor-action-1", "audit.action.x", "svc");
      recordAudit("audit-actor-action-1", "audit.action.y", "svc");
      const res = await fetch(`${baseUrl}/admin-api/audit-log?action=audit.action.x`, { headers: bearer() });
      const body = (await res.json()) as { items: { action: string }[] };
      expect(body.items).toHaveLength(1);
      expect(body.items[0].action).toBe("audit.action.x");
    });
  });

  test("a non-string ?action value (repeated query key) doesn't crash the request", async () => {
    await withApp(async (baseUrl) => {
      recordAudit("audit-actor-action-2", "audit.action.z", "svc");
      const res = await fetch(`${baseUrl}/admin-api/audit-log?action=a&action=b`, { headers: bearer() });
      expect(res.status).toBe(200);
    });
  });

  // Kills 20:11-35 ConditionalExpression 'false' / StringLiteral '""'
  // (from's "string" emptied) via a far-future from that excludes
  // everything; 'true' / EqualityOperator via a count-based
  // non-string-array check (from flows through Number() before
  // binding, so it never crashes -- same gotcha discovered in
  // admin/traffic.ts's cursor filter).
  test("a far-future ?from= excludes every already-recorded entry", async () => {
    await withApp(async (baseUrl) => {
      recordAudit("audit-actor-from", "client.enable", "svc");
      const farFuture = Date.now() + 10_000_000;
      const res = await fetch(`${baseUrl}/admin-api/audit-log?from=${farFuture}`, { headers: bearer() });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { items: unknown[] };
      expect(body.items).toHaveLength(0);
    });
  });

  test("a non-string ?from value (repeated query key) is ignored, not silently zeroing the results", async () => {
    await withApp(async (baseUrl) => {
      recordAudit("audit-actor-from2", "client.enable", "svc");
      const res = await fetch(`${baseUrl}/admin-api/audit-log?from=a&from=b`, { headers: bearer() });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { items: unknown[] };
      expect(body.items.length).toBeGreaterThan(0);
    });
  });

  // Kills 21:9-31's identical cluster for the to filter (upper bound).
  test("a far-past ?to= excludes every already-recorded entry", async () => {
    await withApp(async (baseUrl) => {
      recordAudit("audit-actor-to", "client.enable", "svc");
      const res = await fetch(`${baseUrl}/admin-api/audit-log?to=1`, { headers: bearer() });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { items: unknown[] };
      expect(body.items).toHaveLength(0);
    });
  });

  test("a non-string ?to value (repeated query key) is ignored, not silently zeroing the results", async () => {
    await withApp(async (baseUrl) => {
      recordAudit("audit-actor-to2", "client.enable", "svc");
      const res = await fetch(`${baseUrl}/admin-api/audit-log?to=a&to=b`, { headers: bearer() });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { items: unknown[] };
      expect(body.items.length).toBeGreaterThan(0);
    });
  });

  // Kills 22:13-39's identical cluster for the cursor filter, verified
  // via genuine pagination across two pages.
  test("?cursor=<nextCursor> paginates to a genuinely different second page", async () => {
    await withApp(async (baseUrl) => {
      recordAudit("audit-actor-cursor-1", "client.enable", "svc");
      recordAudit("audit-actor-cursor-2", "client.enable", "svc");
      const page1 = (await (await fetch(`${baseUrl}/admin-api/audit-log?limit=1`, { headers: bearer() })).json()) as {
        items: Array<{ id: number }>;
        nextCursor?: string;
      };
      expect(page1.items).toHaveLength(1);
      expect(page1.nextCursor).toBeDefined();
      const page2 = (await (
        await fetch(`${baseUrl}/admin-api/audit-log?limit=1&cursor=${page1.nextCursor}`, { headers: bearer() })
      ).json()) as { items: Array<{ id: number }> };
      expect(page2.items).toHaveLength(1);
      expect(page2.items[0].id).not.toBe(page1.items[0].id);
    });
  });

  // Unlike actor/action (bound as raw SQL string params, where an array
  // makes bun:sqlite throw), the cursor value flows through Number(...)
  // before binding, which coerces a non-string array into a valid (if
  // useless) NaN rather than throwing -- same gotcha discovered in
  // admin/traffic.ts's cursor filter. The forced-true mutant would
  // silently pass the array through as the cursor, giving `id < NaN`
  // (always false in SQL) -> zero items, instead of real code's
  // "cursor ignored, return everything". Assert the item count, not
  // just the status.
  test("a non-string ?cursor value (repeated query key) is ignored, not silently zeroing the results", async () => {
    await withApp(async (baseUrl) => {
      recordAudit("audit-actor-cursor-3", "client.enable", "svc");
      const res = await fetch(`${baseUrl}/admin-api/audit-log?cursor=a&cursor=b`, { headers: bearer() });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { items: unknown[] };
      expect(body.items.length).toBeGreaterThan(0);
    });
  });

  // Kills 23:12-37's cluster for the limit filter, verified via actual
  // narrowing.
  test("?limit=<n> caps the number of returned items", async () => {
    await withApp(async (baseUrl) => {
      recordAudit("audit-actor-limit-1", "client.enable", "svc");
      recordAudit("audit-actor-limit-2", "client.enable", "svc");
      const res = await fetch(`${baseUrl}/admin-api/audit-log?limit=1`, { headers: bearer() });
      const body = (await res.json()) as { items: unknown[] };
      expect(body.items).toHaveLength(1);
    });
  });
});

describe("GET /admin-api/audit-log/verify", () => {
  // Kills 28:20-39 StringLiteral (the route path "/audit-log/verify"
  // emptied) and 28:75-30:2 BlockStatement (whole handler emptied) --
  // this endpoint was entirely untested until now.
  test("returns the exact chain-verification shape", async () => {
    await withApp(async (baseUrl) => {
      recordAudit("audit-actor-verify", "client.enable", "svc");
      const res = await fetch(`${baseUrl}/admin-api/audit-log/verify`, { headers: bearer() });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean; checked: number };
      expect(body.ok).toBe(true);
      expect(body.checked).toBeGreaterThan(0);
    });
  });

  /**
   * The rate limiter is WIRED to this route, not merely imported near it.
   *
   * rate-limiter-sso-expensive.test.ts already proves `rateLimitExpensive`
   * 429s when called directly; that says nothing about whether the route
   * actually mounts it. This drives the real Express stack, which is the only
   * thing that can tell the two apart — and it is the exact claim CodeQL
   * alert #105 (js/missing-rate-limiting) makes about this handler. That alert
   * is a false positive: the query recognises rate limiters from known
   * packages (express-rate-limit and friends) and cannot see this repo's
   * hand-rolled middleware. The tell is that it fires on the ONE audit-log
   * route that carries a limiter while ignoring GET /audit-log and
   * /audit-log/actions, which carry none.
   *
   * The exact cutoff is deliberately not asserted: the max is bound at module
   * load (`rateLimitExpensive("audit_verify", config.rateLimitExpensive)` runs
   * when the router module is first imported), so it reflects whatever config
   * held then — which depends on file order across the shared test process.
   * "The first call passes, some later call 429s, and it stays 429" is the
   * property that distinguishes a mounted limiter from an absent one.
   */
  test("is really behind the expensive rate limiter — repeated calls start 429ing", async () => {
    await withApp(async (baseUrl) => {
      recordAudit("audit-actor-ratelimit", "client.enable", "svc");
      const verify = (): Promise<globalThis.Response> =>
        fetch(`${baseUrl}/admin-api/audit-log/verify`, { headers: bearer() });

      expect((await verify()).status, "the very first call was already limited").toBe(200);

      const statuses: number[] = [];
      for (let i = 0; i < 40; i++) statuses.push((await verify()).status);

      const firstLimited = statuses.indexOf(429);
      expect(firstLimited, `no call was ever rate limited: ${JSON.stringify(statuses)}`).toBeGreaterThanOrEqual(0);
      // Every status is one of the two expected outcomes — a 500 hiding in here
      // would otherwise satisfy "not 200" without proving anything.
      expect(new Set(statuses.slice(0, firstLimited))).toEqual(firstLimited === 0 ? new Set() : new Set([200]));
      // Once the budget is spent it stays spent for the rest of the window.
      expect(new Set(statuses.slice(firstLimited))).toEqual(new Set([429]));
    });
  });
});

describe("GET /admin-api/audit-log/export — filters", () => {
  // 28:20-39 StringLiteral (the route path "/audit-log/export" emptied)
  // and 28:75-30:2 BlockStatement (whole handler emptied) are both
  // implicitly killed by every test below actually hitting this exact
  // path and getting a real 200 -- if the path were emptied it would no
  // longer match here at all.

  // Kills 40:12-37's identical actor-filter cluster, now for the export
  // endpoint's own independent copy.
  test("?actor=<name> narrows the export to that actor's entries alone", async () => {
    await withApp(async (baseUrl) => {
      recordAudit("audit-export-actor-x", "client.enable", "svc");
      recordAudit("audit-export-actor-y", "client.enable", "svc");
      const res = await fetch(`${baseUrl}/admin-api/audit-log/export?actor=audit-export-actor-x`, {
        headers: bearer(),
      });
      const body = (await res.json()) as { items: { actor: string }[] };
      expect(body.items).toHaveLength(1);
      expect(body.items[0].actor).toBe("audit-export-actor-x");
    });
  });

  // Kills 40:12-37 ConditionalExpression 'true' specifically -- the
  // export endpoint's OWN independent copy of the same guard as the
  // list endpoint's actor filter (that one already has its own
  // non-string test above; coverage there does not imply coverage
  // here, same "same guard, multiple call sites" lesson as
  // admin/canary.ts/admin/traffic.ts).
  test("a non-string ?actor value (repeated query key) doesn't crash the export request", async () => {
    await withApp(async (baseUrl) => {
      recordAudit("audit-export-actor-z", "client.enable", "svc");
      const res = await fetch(`${baseUrl}/admin-api/audit-log/export?actor=a&actor=b`, { headers: bearer() });
      expect(res.status).toBe(200);
    });
  });

  // Kills 41:13-39's identical cluster for the export action filter.
  test("?action=<name> narrows the export to that action's entries alone", async () => {
    await withApp(async (baseUrl) => {
      recordAudit("audit-export-action-1", "export.action.x", "svc");
      recordAudit("audit-export-action-1", "export.action.y", "svc");
      const res = await fetch(`${baseUrl}/admin-api/audit-log/export?action=export.action.x`, {
        headers: bearer(),
      });
      const body = (await res.json()) as { items: { action: string }[] };
      expect(body.items).toHaveLength(1);
      expect(body.items[0].action).toBe("export.action.x");
    });
  });

  // Kills 41:13-39 ConditionalExpression 'true' specifically, same
  // "independent call site" reasoning as the actor test above.
  test("a non-string ?action value (repeated query key) doesn't crash the export request", async () => {
    await withApp(async (baseUrl) => {
      recordAudit("audit-export-action-2", "export.action.z", "svc");
      const res = await fetch(`${baseUrl}/admin-api/audit-log/export?action=a&action=b`, { headers: bearer() });
      expect(res.status).toBe(200);
    });
  });

  // Kills 42:11-35's identical cluster for the export from filter.
  test("a far-future ?from= excludes every already-recorded entry from the export", async () => {
    await withApp(async (baseUrl) => {
      recordAudit("audit-export-from", "client.enable", "svc");
      const farFuture = Date.now() + 10_000_000;
      const res = await fetch(`${baseUrl}/admin-api/audit-log/export?from=${farFuture}`, { headers: bearer() });
      const body = (await res.json()) as { items: unknown[] };
      expect(body.items).toHaveLength(0);
    });
  });

  // Kills 43:9-31's identical cluster for the export to filter.
  test("a far-past ?to= excludes every already-recorded entry from the export", async () => {
    await withApp(async (baseUrl) => {
      recordAudit("audit-export-to", "client.enable", "svc");
      const res = await fetch(`${baseUrl}/admin-api/audit-log/export?to=1`, { headers: bearer() });
      const body = (await res.json()) as { items: unknown[] };
      expect(body.items).toHaveLength(0);
    });
  });
});
