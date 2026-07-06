/**
 * Tests for the liveness / readiness / health endpoint split
 * (P1-7 in docs/REVIEW.md §2.5).
 *
 *   /livez  — always 200; the process is responding
 *   /readyz — 200 only when the instance holds the leader lease AND
 *             SQLite answers SELECT 1
 *   /health — legacy generic, 200 + uptime_seconds
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import express from "express";
import type { AddressInfo } from "net";
import type { Server } from "http";
import { __resetDbForTesting } from "../db/connection.js";
import { requestIdMiddleware } from "../middleware/request-id.js";
import { checkReadiness, healthRoutes } from "../routes/health.js";
import {
  isLeader,
  refreshLeaderStatus,
  tryAcquireOrRenewLease,
  __resetLeaderFlagForTesting,
} from "../db/leader-lease.js";

let baseUrl = "";
let activeServer: Server | null = null;

async function startApp(): Promise<void> {
  __resetDbForTesting();
  const app = express();
  app.use(requestIdMiddleware);
  healthRoutes(app);
  return new Promise((resolve, reject) => {
    const srv = app.listen(0, "127.0.0.1", () => {
      const addr = srv.address() as AddressInfo;
      baseUrl = `http://127.0.0.1:${addr.port}`;
      activeServer = srv;
      resolve();
    });
    srv.on("error", reject);
  });
}

function stopServer(): Promise<void> {
  return new Promise((resolve) => {
    if (activeServer) {
      activeServer.close(() => {
        activeServer = null;
        resolve();
      });
    } else {
      resolve();
    }
  });
}

beforeEach(() => {
  // Reset the leader state — tests below want full control over whether
  // the instance holds the lease. __resetDbForTesting() clears the lease
  // row (a stale row from a different test in this run would carry a
  // different `holder_id` and block our own acquire), and the flag reset
  // clears the in-memory `isLeader()` cache.
  __resetDbForTesting();
  __resetLeaderFlagForTesting();
});

afterEach(async () => {
  await stopServer();
});

describe("checkReadiness (pure)", () => {
  test("reports not ready + reason 'not_leader' when no lease is held", () => {
    // No acquire yet — isLeader() is the in-memory flag, defaults to false.
    expect(isLeader()).toBe(false);
    const report = checkReadiness();
    expect(report.ready).toBe(false);
    expect(report.reasons).toContain("not_leader");
  });

  test("reports ready with no reasons when lease is held and DB is up", () => {
    tryAcquireOrRenewLease();
    refreshLeaderStatus();
    expect(isLeader()).toBe(true);
    const report = checkReadiness();
    expect(report.ready).toBe(true);
    expect(report.reasons).toEqual([]);
  });
});

describe("HTTP endpoints", () => {
  test("/livez returns 200 and the alive payload (always)", async () => {
    await startApp();
    const res = await fetch(`${baseUrl}/livez`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("alive");
  });

  test("/readyz returns 503 with reason 'not_leader' before the lease is acquired", async () => {
    await startApp();
    const res = await fetch(`${baseUrl}/readyz`);
    expect(res.status).toBe(503);
    const body = (await res.json()) as { status: string; reasons: string[] };
    expect(body.status).toBe("not_ready");
    expect(body.reasons).toContain("not_leader");
  });

  test("/readyz returns 200 after the instance acquires the leader lease", async () => {
    await startApp();
    tryAcquireOrRenewLease();
    refreshLeaderStatus();
    const res = await fetch(`${baseUrl}/readyz`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; reasons: string[] };
    expect(body.status).toBe("ready");
    expect(body.reasons).toEqual([]);
  });

  test("/health returns 200 + uptime (legacy generic endpoint preserved)", async () => {
    await startApp();
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; uptime_seconds: number };
    expect(body.status).toBe("ok");
    expect(typeof body.uptime_seconds).toBe("number");
    expect(body.uptime_seconds).toBeGreaterThanOrEqual(0);
  });
});
