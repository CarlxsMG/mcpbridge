/**
 * HTTP-level tests for src/routes/config-io.ts.
 */
import { describe, test, expect, afterEach } from "bun:test";
import express from "express";
import type { AddressInfo } from "net";
import type { Server } from "http";
import { config } from "../config.js";
import { __resetDbForTesting } from "../db/connection.js";
import { requestIdMiddleware } from "../middleware/request-id.js";

let baseUrl = "";
let server: Server | null = null;
const ADMIN_KEY = "test-admin-key";

async function startApp(): Promise<void> {
  __resetDbForTesting();
  (config as Record<string, unknown>).adminApiKeys = [ADMIN_KEY];
  (config as Record<string, unknown>).authDisabled = false;
  const { configIoRoutes } = await import("../routes/config-io.js");
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use(requestIdMiddleware);
  configIoRoutes(app);
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

describe("config-io routes", () => {
  test("export returns a versioned document", async () => {
    await startApp();
    const res = await fetch(`${baseUrl}/admin-api/config/export`, { headers: bearer() });
    expect(res.status).toBe(200);
    const doc = (await res.json()) as { version: number; bundles: unknown[] };
    expect(doc.version).toBe(1);
    expect(Array.isArray(doc.bundles)).toBe(true);
  });

  test("import (dry-run) accepts a document", async () => {
    await startApp();
    const doc = { version: 1, exportedAt: 0, bundles: [], alertRules: [], clients: [] };
    const res = await fetch(`${baseUrl}/admin-api/config/import`, {
      method: "POST",
      headers: bearer(),
      body: JSON.stringify({ dryRun: true, data: doc }),
    });
    expect(res.status).toBe(200);
    const result = (await res.json()) as { dryRun: boolean };
    expect(result.dryRun).toBe(true);
  });

  test("import rejects an unsupported version with 400", async () => {
    await startApp();
    const res = await fetch(`${baseUrl}/admin-api/config/import`, {
      method: "POST",
      headers: bearer(),
      body: JSON.stringify({ data: { version: 999 } }),
    });
    expect(res.status).toBe(400);
  });

  test("requires auth", async () => {
    await startApp();
    const res = await fetch(`${baseUrl}/admin-api/config/export`);
    expect(res.status).toBe(401);
  });
});
