/**
 * HTTP-level test for the "Connect client" config generator's one backend
 * route: GET /admin-api/connect/gateway-url (src/routes/admin.ts). Read-only,
 * so no recordAudit / tenancy checks apply — see the route's own comment.
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
  const { adminRoutes } = await import("../../routes/admin.js");
  const app = express();
  app.use(express.json());
  app.use(requestIdMiddleware);
  adminRoutes(app);
  ({ baseUrl, server } = await listen(app));
}

const bearer = (): Record<string, string> => jsonBearerHeaders(ADMIN_KEY);

afterEach(async () => {
  (config as Record<string, unknown>).gatewayPublicUrl = undefined;
  await new Promise<void>((resolve) => {
    if (server)
      server.close(() => {
        server = null;
        resolve();
      });
    else resolve();
  });
});

describe("GET /admin-api/connect/gateway-url", () => {
  test("requires auth", async () => {
    await startApp();
    const res = await fetch(`${baseUrl}/admin-api/connect/gateway-url`);
    expect(res.status).toBe(401);
  });

  test("returns null when GATEWAY_PUBLIC_URL is unset", async () => {
    await startApp();
    const res = await fetch(`${baseUrl}/admin-api/connect/gateway-url`, { headers: bearer() });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ publicUrl: null });
  });

  test("returns the configured public URL when set", async () => {
    await startApp();
    (config as Record<string, unknown>).gatewayPublicUrl = "https://gw.example.com";
    const res = await fetch(`${baseUrl}/admin-api/connect/gateway-url`, { headers: bearer() });
    expect(await res.json()).toEqual({ publicUrl: "https://gw.example.com" });
  });
});
