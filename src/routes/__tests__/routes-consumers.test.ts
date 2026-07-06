/**
 * HTTP-level tests for src/routes/consumers.ts.
 */
import { describe, test, expect, afterEach } from "bun:test";
import express from "express";
import type { AddressInfo } from "net";
import type { Server } from "http";
import { config } from "../../config.js";
import { __resetDbForTesting } from "../../db/connection.js";
import { requestIdMiddleware } from "../../middleware/request-id.js";

let baseUrl = "";
let server: Server | null = null;
const ADMIN_KEY = "test-admin-key";

async function startApp(): Promise<void> {
  __resetDbForTesting();
  (config as Record<string, unknown>).adminApiKeys = [ADMIN_KEY];
  (config as Record<string, unknown>).authDisabled = false;
  const { consumerRoutes } = await import("../../routes/consumers.js");
  const app = express();
  app.use(express.json());
  app.use(requestIdMiddleware);
  consumerRoutes(app);
  return new Promise((resolve, reject) => {
    const srv = app.listen(0, "127.0.0.1", () => {
      baseUrl = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
      server = srv;
      resolve();
    });
    srv.on("error", reject);
  });
}

function bearer(): Record<string, string> {
  return { Authorization: `Bearer ${ADMIN_KEY}`, "Content-Type": "application/json" };
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

describe("consumer routes", () => {
  test("create / list / duplicate / usage / delete", async () => {
    await startApp();
    const create = await fetch(`${baseUrl}/admin-api/consumers`, {
      method: "POST",
      headers: bearer(),
      body: JSON.stringify({ name: "team-a", monthlyQuota: 100 }),
    });
    expect(create.status).toBe(201);
    const { id } = (await create.json()) as { id: number };

    const dup = await fetch(`${baseUrl}/admin-api/consumers`, {
      method: "POST",
      headers: bearer(),
      body: JSON.stringify({ name: "team-a" }),
    });
    expect(dup.status).toBe(409);

    const list = (await (await fetch(`${baseUrl}/admin-api/consumers`, { headers: bearer() })).json()) as {
      items: { usedThisMonth: number }[];
    };
    expect(list.items[0].usedThisMonth).toBe(0);

    const usage = (await (await fetch(`${baseUrl}/admin-api/consumers/${id}/usage`, { headers: bearer() })).json()) as {
      quota: number;
    };
    expect(usage.quota).toBe(100);

    const del = await fetch(`${baseUrl}/admin-api/consumers/${id}`, { method: "DELETE", headers: bearer() });
    expect(del.status).toBe(200);
  });

  test("400 for a non-integer quota", async () => {
    await startApp();
    const res = await fetch(`${baseUrl}/admin-api/consumers`, {
      method: "POST",
      headers: bearer(),
      body: JSON.stringify({ name: "x", monthlyQuota: 1.5 }),
    });
    expect(res.status).toBe(400);
  });

  test("endUserRateLimitPerMin: accepts a positive integer, rejects non-integer/negative, defaults to null", async () => {
    await startApp();
    const create = await fetch(`${baseUrl}/admin-api/consumers`, {
      method: "POST",
      headers: bearer(),
      body: JSON.stringify({ name: "team-b", endUserRateLimitPerMin: 15 }),
    });
    expect(create.status).toBe(201);
    const created = (await create.json()) as { id: number; endUserRateLimitPerMin: number | null };
    expect(created.endUserRateLimitPerMin).toBe(15);

    const badCreate = await fetch(`${baseUrl}/admin-api/consumers`, {
      method: "POST",
      headers: bearer(),
      body: JSON.stringify({ name: "team-c", endUserRateLimitPerMin: -1 }),
    });
    expect(badCreate.status).toBe(400);

    const patch = await fetch(`${baseUrl}/admin-api/consumers/${created.id}`, {
      method: "PATCH",
      headers: bearer(),
      body: JSON.stringify({ endUserRateLimitPerMin: null }),
    });
    expect(patch.status).toBe(200);
    const patched = (await patch.json()) as { endUserRateLimitPerMin: number | null };
    expect(patched.endUserRateLimitPerMin).toBeNull();

    const badPatch = await fetch(`${baseUrl}/admin-api/consumers/${created.id}`, {
      method: "PATCH",
      headers: bearer(),
      body: JSON.stringify({ endUserRateLimitPerMin: 1.5 }),
    });
    expect(badPatch.status).toBe(400);
  });

  test("requires auth", async () => {
    await startApp();
    const res = await fetch(`${baseUrl}/admin-api/consumers`);
    expect(res.status).toBe(401);
  });
});
