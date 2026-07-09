/**
 * Stryker mutation-testing backstop for src/routes/health.ts — domain 8.
 * Baseline: 36 mutants, 0 killed / 36 survived — zero test coverage of any
 * kind existed before this. All line:col citations below were read directly
 * from reports/mutation/result.json.
 *
 * One survivor is an accepted EQUIVALENT, not chased with a dedicated test:
 * 4:48:11-50:4 BlockStatement (`dbUp`'s `catch { return false; }` body
 * emptied to `catch {}`). `dbUp()` has exactly one call site,
 * `if (!dbUp())` in `checkReadiness`, which only ever consumes the return
 * value through `!`. The real `return false` and the mutant's implicit
 * `return undefined` (falling off the end of an empty catch block) are
 * both falsy, so `!false` and `!undefined` are identically `true` — no
 * test can observe a difference through the only path that reads this
 * value.
 */
import { describe, test, expect, spyOn } from "bun:test";
import express from "express";
import type { AddressInfo } from "net";
import type { Server } from "http";
import { __resetDbForTesting } from "../../db/connection.js";
import * as dbConnMod from "../../db/connection.js";
import { refreshLeaderStatus, __resetLeaderFlagForTesting } from "../../db/leader-lease.js";

async function startApp(): Promise<{ baseUrl: string; server: Server }> {
  __resetDbForTesting();
  __resetLeaderFlagForTesting();
  const { healthRoutes } = await import("../../routes/health.js");
  const app = express();
  healthRoutes(app);
  return new Promise((resolve, reject) => {
    const srv = app.listen(0, "127.0.0.1", () => {
      resolve({ baseUrl: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`, server: srv });
    });
    srv.on("error", reject);
  });
}

async function withApp(fn: (baseUrl: string) => Promise<void>): Promise<void> {
  const { baseUrl, server } = await startApp();
  try {
    await fn(baseUrl);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe("GET /livez", () => {
  // Kills 20 (whole healthRoutes body emptied), 21 (route path emptied), 22
  // (handler body emptied), 23/24 (the `{ status: "alive" }` object/string
  // literals emptied) via an exact body assertion.
  test("always returns the exact alive 200 shape", async () => {
    await withApp(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/livez`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ status: "alive" });
    });
  });
});

describe("GET /readyz", () => {
  // Kills 6 (whole checkReadiness body emptied), 7 (the `reasons = []`
  // array seeded with junk instead of empty), 0/1/2/3 (dbUp's function/try
  // body/SQL-literal/return-true emptied or forced false -- all would
  // wrongly report db_unavailable), 8/9/10/11 (the `!isLeader()` negation/
  // conditional/string-literal cluster's "always not ready" directions),
  // 12/13/14/15 (the `!dbUp()` cluster's "always not ready" directions),
  // 16 (the response object emptied), 17/18/19 (the `reasons.length === 0`
  // cluster's "always ready" directions), 25/26 (route path/handler body
  // emptied), 27/28 (the response object and "ready" literal emptied).
  test("leader + db up returns the exact ready 200 shape", async () => {
    await withApp(async (baseUrl) => {
      refreshLeaderStatus();
      const res = await fetch(`${baseUrl}/readyz`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ status: "ready", reasons: [] });
    });
  });

  // Kills the complementary "always ready"/negation-removed directions of
  // 8/9/10/11 and 17/18/19, plus 29 (the "not_ready" literal emptied), via
  // the not-leader-only branch.
  test("not leader returns the exact not_ready 503 shape with not_leader reason", async () => {
    await withApp(async (baseUrl) => {
      // __resetLeaderFlagForTesting() in startApp() already leaves this
      // instance as not-leader; assert that starting state explicitly.
      const res = await fetch(`${baseUrl}/readyz`);
      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body).toEqual({ status: "not_ready", reasons: ["not_leader"] });
    });
  });

  // Kills the complementary directions of 12/13/14/15 via the
  // db-unavailable-only branch (leader is true here, isolating the dbUp
  // guard specifically).
  test("db unavailable returns the exact not_ready 503 shape with db_unavailable reason", async () => {
    await withApp(async (baseUrl) => {
      refreshLeaderStatus();
      const spy = spyOn(dbConnMod, "getDb").mockImplementation(() => {
        throw new Error("db down");
      });
      try {
        const res = await fetch(`${baseUrl}/readyz`);
        expect(res.status).toBe(503);
        const body = await res.json();
        expect(body).toEqual({ status: "not_ready", reasons: ["db_unavailable"] });
      } finally {
        spy.mockRestore();
      }
    });
  });

  // Proves both pushes onto `reasons` are independent and additive, in
  // order -- a mutant that short-circuited after the first `if` (instead
  // of evaluating both) would only ever report one reason, not both.
  test("not leader AND db unavailable combines both reasons in order", async () => {
    await withApp(async (baseUrl) => {
      const spy = spyOn(dbConnMod, "getDb").mockImplementation(() => {
        throw new Error("db down");
      });
      try {
        const res = await fetch(`${baseUrl}/readyz`);
        expect(res.status).toBe(503);
        const body = await res.json();
        expect(body).toEqual({ status: "not_ready", reasons: ["not_leader", "db_unavailable"] });
      } finally {
        spy.mockRestore();
      }
    });
  });
});

describe("GET /health", () => {
  // Kills 30 (route path emptied), 31 (handler body emptied), 32/33 (the
  // response object and "ok" literal emptied), and 34/35 (the
  // `(Date.now() - startedAt) / 1000` arithmetic -- `/` flipped to `*` or
  // `-` flipped to `+`, either of which inflates the result from a small
  // number of seconds to a value in the billions).
  test("returns the exact ok status with a small non-negative uptime_seconds", async () => {
    await withApp(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/health`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { status: string; uptime_seconds: number };
      expect(body.status).toBe("ok");
      expect(body.uptime_seconds).toBeGreaterThanOrEqual(0);
      expect(body.uptime_seconds).toBeLessThan(86400);
    });
  });
});
