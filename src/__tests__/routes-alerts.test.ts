/**
 * HTTP-level tests for src/routes/alerts.ts.
 */
import { describe, test, expect, afterEach } from "bun:test";
import express from "express";
import type { AddressInfo } from "net";
import type { Server } from "http";
import { config } from "../config.js";
import { __resetDbForTesting } from "../db/connection.js";
import { requestIdMiddleware } from "../middleware/request-id.js";

let baseUrl = "";
let activeServer: Server | null = null;
const ADMIN_KEY = "test-admin-key";
const originalFetch = globalThis.fetch;
const originalAllowPrivate = config.allowPrivateIps;

async function startApp(): Promise<void> {
  __resetDbForTesting();
  (config as Record<string, unknown>).adminApiKeys = [ADMIN_KEY];
  (config as Record<string, unknown>).authDisabled = false;
  (config as Record<string, unknown>).allowPrivateIps = true;

  const { alertRoutes } = await import("../routes/alerts.js");
  const app = express();
  app.use(express.json());
  app.use(requestIdMiddleware);
  alertRoutes(app);

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
  return { Authorization: `Bearer ${ADMIN_KEY}`, "Content-Type": "application/json" };
}

afterEach(async () => {
  await new Promise<void>((resolve) => {
    if (activeServer) activeServer.close(() => { activeServer = null; resolve(); });
    else resolve();
  });
  globalThis.fetch = originalFetch;
  (config as Record<string, unknown>).allowPrivateIps = originalAllowPrivate;
});

async function create(body: Record<string, unknown>): Promise<Response> {
  return fetch(`${baseUrl}/admin-api/alerts`, { method: "POST", headers: bearer(), body: JSON.stringify(body) });
}

describe("alert routes", () => {
  test("create, list, patch, delete", async () => {
    await startApp();
    const createRes = await create({ name: "cb", eventType: "circuit_breaker_open", webhookUrl: "http://127.0.0.1:9/x" });
    expect(createRes.status).toBe(201);
    const { id } = (await createRes.json()) as { id: number };

    const list = (await (await fetch(`${baseUrl}/admin-api/alerts`, { headers: bearer() })).json()) as { items: unknown[] };
    expect(list.items).toHaveLength(1);

    const patch = await fetch(`${baseUrl}/admin-api/alerts/${id}`, { method: "PATCH", headers: bearer(), body: JSON.stringify({ enabled: false }) });
    expect(patch.status).toBe(200);

    const del = await fetch(`${baseUrl}/admin-api/alerts/${id}`, { method: "DELETE", headers: bearer() });
    expect(del.status).toBe(200);
  });

  test("400 for an invalid event type", async () => {
    await startApp();
    const res = await create({ name: "x", eventType: "nope", webhookUrl: "http://127.0.0.1:9/x" });
    expect(res.status).toBe(400);
  });

  test("400 for a non-http webhook url", async () => {
    await startApp();
    const res = await create({ name: "x", eventType: "client_unreachable", webhookUrl: "ftp://nope" });
    expect(res.status).toBe(400);
  });

  test("test endpoint delivers to the webhook", async () => {
    await startApp();
    // Use a real local receiver (not a fetch mock) — the admin client and the
    // server-side webhook dispatch share the same globalThis.fetch.
    let delivered = 0;
    const recv = express();
    recv.post("/hook", (_req, res) => { delivered++; res.json({ ok: true }); });
    const recvServer = await new Promise<Server>((resolve) => {
      const s = recv.listen(0, "127.0.0.1", () => resolve(s));
    });
    const port = (recvServer.address() as AddressInfo).port;
    try {
      const createRes = await create({ name: "cb", eventType: "circuit_breaker_open", webhookUrl: `http://127.0.0.1:${port}/hook` });
      const { id } = (await createRes.json()) as { id: number };
      const testRes = await fetch(`${baseUrl}/admin-api/alerts/${id}/test`, { method: "POST", headers: bearer() });
      expect(testRes.status).toBe(200);
      expect(delivered).toBe(1);
    } finally {
      recvServer.close();
    }
  });

  test("requires auth", async () => {
    await startApp();
    const res = await fetch(`${baseUrl}/admin-api/alerts`);
    expect(res.status).toBe(401);
  });
});
