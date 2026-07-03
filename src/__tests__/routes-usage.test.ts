/**
 * HTTP-level tests for src/routes/usage.ts.
 */
import { describe, test, expect, afterEach } from "bun:test";
import express from "express";
import type { AddressInfo } from "net";
import type { Server } from "http";
import { config } from "../config.js";
import { __resetDbForTesting } from "../db/connection.js";
import { requestIdMiddleware } from "../middleware/request-id.js";
import { recordUsage } from "../observability/usage.js";

let baseUrl = "";
let activeServer: Server | null = null;
const ADMIN_KEY = "test-admin-key";

async function startApp(): Promise<void> {
  __resetDbForTesting();
  (config as Record<string, unknown>).adminApiKeys = [ADMIN_KEY];
  (config as Record<string, unknown>).authDisabled = false;

  const { usageRoutes } = await import("../routes/usage.js");
  const app = express();
  app.use(express.json());
  app.use(requestIdMiddleware);
  usageRoutes(app);

  return new Promise((resolve, reject) => {
    const srv = app.listen(0, "127.0.0.1", () => {
      baseUrl = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
      activeServer = srv;
      resolve();
    });
    srv.on("error", reject);
  });
}

function bearer(): Record<string, string> {
  return { Authorization: `Bearer ${ADMIN_KEY}` };
}

afterEach(async () => {
  await new Promise<void>((resolve) => {
    if (activeServer)
      activeServer.close(() => {
        activeServer = null;
        resolve();
      });
    else resolve();
  });
});

describe("usage routes", () => {
  test("summary + top-tools reflect recorded calls", async () => {
    await startApp();
    recordUsage({ clientName: "svc", toolName: "a", keyId: null, statusClass: "2xx", isError: false, durationMs: 5 });
    recordUsage({ clientName: "svc", toolName: "a", keyId: null, statusClass: "5xx", isError: true, durationMs: 5 });

    const summary = await (await fetch(`${baseUrl}/admin-api/usage/summary`, { headers: bearer() })).json();
    expect((summary as { calls: number }).calls).toBe(2);
    expect((summary as { errors: number }).errors).toBe(1);

    const top = await (await fetch(`${baseUrl}/admin-api/usage/top-tools`, { headers: bearer() })).json();
    expect((top as { items: { tool: string }[] }).items[0].tool).toBe("a");
  });

  test("timeseries endpoint returns bucketed, zero-filled points", async () => {
    await startApp();
    recordUsage({ clientName: "svc", toolName: "a", keyId: null, statusClass: "2xx", isError: false, durationMs: 5 });

    const res = await fetch(`${baseUrl}/admin-api/usage/timeseries?bucketMs=3600000`, { headers: bearer() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { bucketMs: number; points: { t: number; calls: number }[] };
    expect(body.bucketMs).toBe(3_600_000);
    expect(body.points.reduce((sum, p) => sum + p.calls, 0)).toBe(1);
  });

  test("by-key endpoint returns grouped rows", async () => {
    await startApp();
    recordUsage({ clientName: "svc", toolName: "a", keyId: null, statusClass: "2xx", isError: false, durationMs: 5 });
    const byKey = await (await fetch(`${baseUrl}/admin-api/usage/by-key`, { headers: bearer() })).json();
    expect((byKey as { items: unknown[] }).items.length).toBeGreaterThan(0);
  });

  test("requires auth", async () => {
    await startApp();
    const res = await fetch(`${baseUrl}/admin-api/usage/summary`);
    expect(res.status).toBe(401);
  });
});
