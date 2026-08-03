/**
 * HTTP-level tests for src/routes/config-io.ts.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { listen } from "../../__tests__/_utils/app.js";
import { jsonBearerHeaders, setAdminApiKeys } from "../../__tests__/_utils/admin-auth.js";
import express from "express";
import type { Server } from "http";
import { config } from "../../config.js";
import { __resetDbForTesting } from "../../db/connection.js";
import { requestIdMiddleware } from "../../middleware/request-id.js";

let baseUrl = "";
let server: Server | null = null;
const ADMIN_KEY = "test-admin-key";

async function startApp(): Promise<void> {
  __resetDbForTesting();
  setAdminApiKeys([ADMIN_KEY]);
  (config as Record<string, unknown>).authDisabled = false;
  const { configIoRoutes } = await import("../../routes/config-io.js");
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use(requestIdMiddleware);
  configIoRoutes(app);
  ({ baseUrl, server } = await listen(app));
}

const bearer = (): Record<string, string> => jsonBearerHeaders(ADMIN_KEY);

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

describe("GET /admin-api/config/effective", () => {
  test("returns the resolved settings, sorted, with nodeEnv", async () => {
    await startApp();
    const res = await fetch(`${baseUrl}/admin-api/config/effective`, { headers: bearer() });
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      nodeEnv: string;
      entries: { key: string; value: unknown; redacted: boolean }[];
    };
    expect(typeof body.nodeEnv).toBe("string");
    expect(body.entries.length).toBeGreaterThan(50);

    const keys = body.entries.map((e) => e.key);
    expect(keys).toEqual([...keys].sort());
    expect(body.entries.find((e) => e.key === "toolCallTimeoutMs")?.value).toBe(config.toolCallTimeoutMs);
  });

  test("never serves the admin API keys it is authenticating this very request with", async () => {
    await startApp();
    const res = await fetch(`${baseUrl}/admin-api/config/effective`, { headers: bearer() });
    const raw = await res.text();

    // The sharpest available check: the caller's own bearer token is a live
    // ADMIN_API_KEYS value at this moment, so if redaction were bypassed the
    // response would contain it verbatim.
    expect(raw).not.toContain(ADMIN_KEY);
    const body = JSON.parse(raw) as { entries: { key: string; value: unknown; redacted: boolean }[] };
    const entry = body.entries.find((e) => e.key === "adminApiKeys")!;
    expect(entry.redacted).toBe(true);
    expect(entry.value).toBe("set");
  });

  test("requires auth", async () => {
    await startApp();
    const res = await fetch(`${baseUrl}/admin-api/config/effective`);
    expect(res.status).toBe(401);
  });
});
