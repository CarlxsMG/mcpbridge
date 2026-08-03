/**
 * HTTP-level tests for src/routes/tags.ts.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { clearRegistry } from "../../__tests__/_utils/registry.js";
import { listen } from "../../__tests__/_utils/app.js";
import { jsonBearerHeaders, setAdminApiKeys } from "../../__tests__/_utils/admin-auth.js";
import express from "express";
import type { Server } from "http";
import { config } from "../../config.js";
import { __resetDbForTesting } from "../../db/connection.js";
import { registry } from "../../mcp/registry.js";
import { requestIdMiddleware } from "../../middleware/request-id.js";
import type { RestToolDefinition } from "../../mcp/types.js";

let baseUrl = "";
let server: Server | null = null;
const ADMIN_KEY = "test-admin-key";

function makeTool(name: string): RestToolDefinition {
  return {
    name,
    method: "GET",
    endpoint: `/${name}`,
    description: "d",
    inputSchema: { type: "object", properties: {} },
  };
}

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

async function reg(name: string): Promise<void> {
  await registry.register(
    name,
    [makeTool("t")],
    "http://example.com/health",
    "1.2.3.4",
    "http://example.com",
    "1.2.3.4",
  );
}

afterEach(async () => {
  await clearRegistry();
  await new Promise<void>((resolve) => {
    if (server)
      server.close(() => {
        server = null;
        resolve();
      });
    else resolve();
  });
});

describe("tag routes", () => {
  test("set tags then list them", async () => {
    await startApp();
    await reg("svc");
    const put = await fetch(`${baseUrl}/admin-api/clients/svc/tools/t/tags`, {
      method: "PUT",
      headers: bearer(),
      body: JSON.stringify({ tags: ["billing", "read"] }),
    });
    expect(put.status).toBe(200);

    const tags = (await (await fetch(`${baseUrl}/admin-api/tags`, { headers: bearer() })).json()) as {
      items: { tag: string; count: number }[];
    };
    expect(tags.items.map((t) => t.tag).sort()).toEqual(["billing", "read"]);

    const byTag = (await (await fetch(`${baseUrl}/admin-api/tags/billing/tools`, { headers: bearer() })).json()) as {
      items: { tool: string }[];
    };
    expect(byTag.items[0].tool).toBe("t");
  });

  test("400 for an invalid tag", async () => {
    await startApp();
    await reg("svc");
    const put = await fetch(`${baseUrl}/admin-api/clients/svc/tools/t/tags`, {
      method: "PUT",
      headers: bearer(),
      body: JSON.stringify({ tags: ["has space"] }),
    });
    expect(put.status).toBe(400);
  });

  test("404 for an unknown tool", async () => {
    await startApp();
    await reg("svc");
    const put = await fetch(`${baseUrl}/admin-api/clients/svc/tools/nope/tags`, {
      method: "PUT",
      headers: bearer(),
      body: JSON.stringify({ tags: ["x"] }),
    });
    expect(put.status).toBe(404);
  });

  test("requires auth", async () => {
    await startApp();
    const res = await fetch(`${baseUrl}/admin-api/tags`);
    expect(res.status).toBe(401);
  });
});
