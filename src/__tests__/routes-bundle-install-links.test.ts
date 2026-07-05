/**
 * HTTP-level tests for the shareable "install this bundle" link feature:
 * the admin-only CRUD routes added to src/routes/bundles.ts (POST/GET/DELETE
 * /admin-api/bundles/:name/install-links) and the public, unauthenticated
 * GET /install/:token route in src/routes/install-links.ts. Mirrors
 * routes-bundles.test.ts / routes-mcp-keys.test.ts's harness conventions.
 *
 * Uses a client/bundle name namespace unique to this file ("install-link-*")
 * per the shared-process test-isolation convention (module-level singletons —
 * the circuit breaker map, the bundle/registry caches — are never reset
 * between test files in the same `bun run test` run).
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import express from "express";
import type { AddressInfo } from "net";
import type { Server } from "http";
import { config } from "../config.js";
import { __resetDbForTesting } from "../db/connection.js";
import { registry } from "../mcp/registry.js";
import { initBundles } from "../admin/tool-composition/bundles.js";
import { requestIdMiddleware } from "../middleware/request-id.js";
import { createUser } from "../security/user-store.js";
import { createSession } from "../security/session-store.js";
import { SESSION_COOKIE_NAME, CSRF_COOKIE_NAME } from "../security/cookies.js";
import { _internalsForTesting } from "../middleware/rate-limiter.js";
import type { RestToolDefinition } from "../mcp/types.js";

let baseUrl = "";
let activeServer: Server | null = null;
const ADMIN_KEY = "test-admin-key";
const originalSecretKey = config.secretEncryptionKey;

async function startApp(withSecretBox = true): Promise<void> {
  __resetDbForTesting();
  initBundles();
  _internalsForTesting.installLinkBuckets.clear();
  (config as Record<string, unknown>).adminApiKeys = [ADMIN_KEY];
  (config as Record<string, unknown>).authDisabled = false;
  (config as Record<string, unknown>).secretEncryptionKey = withSecretBox
    ? Buffer.alloc(32, 5).toString("base64")
    : undefined;

  const { adminRoutes } = await import("../routes/admin.js");
  const { bundleRoutes } = await import("../routes/bundles.js");
  const { installLinkRoutes } = await import("../routes/install-links.js");
  const { mcpKeyRoutes } = await import("../routes/mcp-keys.js");
  const app = express();
  app.use(express.json({ limit: "64kb", strict: true }));
  app.use(requestIdMiddleware);
  adminRoutes(app);
  bundleRoutes(app);
  installLinkRoutes(app);
  mcpKeyRoutes(app);

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

function bearer(): Record<string, string> {
  return { Authorization: `Bearer ${ADMIN_KEY}`, "Content-Type": "application/json" };
}

function makeTool(overrides: Partial<RestToolDefinition> = {}): RestToolDefinition {
  return {
    name: "install-link-tool",
    method: "GET",
    endpoint: "/things",
    description: "Returns a list of things",
    inputSchema: { type: "object", properties: {} },
    ...overrides,
  };
}

async function reg(name: string, tools: RestToolDefinition[] = [makeTool()]): Promise<void> {
  await registry.register(name, tools, "http://example.com/health", "1.2.3.4", "http://example.com", "1.2.3.4");
}

async function createBundleWithTool(bundleName: string, clientName: string): Promise<void> {
  await reg(clientName);
  const res = await fetch(`${baseUrl}/admin-api/bundles`, {
    method: "POST",
    headers: bearer(),
    body: JSON.stringify({ name: bundleName, tools: [{ client: clientName, tool: "install-link-tool" }] }),
  });
  expect(res.status).toBe(201);
}

beforeEach(async () => {
  for (const c of registry.listClients()) {
    await registry.unregister(c.name);
  }
});

afterEach(async () => {
  for (const c of registry.listClients()) {
    await registry.unregister(c.name);
  }
  await stopServer();
  (config as Record<string, unknown>).secretEncryptionKey = originalSecretKey;
});

describe("POST /admin-api/bundles/:name/install-links", () => {
  test("mints a scoped MCP key + install token, returns the raw token exactly once, and audits the action", async () => {
    await startApp();
    await createBundleWithTool("install-link-bundle-a", "install-link-svc-a");

    const res = await fetch(`${baseUrl}/admin-api/bundles/install-link-bundle-a/install-links`, {
      method: "POST",
      headers: bearer(),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      id: number;
      bundleName: string;
      tokenPrefix: string;
      token: string;
      mcpKeyId: number;
      revokedAt: null;
    };
    expect(body.token.startsWith("bil_")).toBe(true);
    expect(body.tokenPrefix).toBe(body.token.slice(0, 12));
    expect(body.bundleName).toBe("install-link-bundle-a");
    expect(body.revokedAt).toBeNull();
    expect(typeof body.mcpKeyId).toBe("number");

    // A subsequent list must never expose the raw token again.
    const listRes = await fetch(`${baseUrl}/admin-api/bundles/install-link-bundle-a/install-links`, {
      headers: bearer(),
    });
    const list = (await listRes.json()) as { items: Record<string, unknown>[] };
    expect(JSON.stringify(list.items)).not.toContain(body.token);
    expect(list.items[0].token).toBeUndefined();

    const auditRes = await fetch(`${baseUrl}/admin-api/audit-log`, { headers: bearer() });
    const audit = (await auditRes.json()) as { items: { action: string; target: string }[] };
    expect(
      audit.items.some((e) => e.action === "bundle.install_link.create" && e.target === "install-link-bundle-a"),
    ).toBe(true);
  });

  test("404 for an unknown bundle", async () => {
    await startApp();
    const res = await fetch(`${baseUrl}/admin-api/bundles/nobody-install/install-links`, {
      method: "POST",
      headers: bearer(),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("BUNDLE_NOT_FOUND");
  });

  test("400 (EMPTY_BUNDLE) for a bundle with no tools — never mints an unrestricted key", async () => {
    await startApp();
    const create = await fetch(`${baseUrl}/admin-api/bundles`, {
      method: "POST",
      headers: bearer(),
      body: JSON.stringify({ name: "install-link-bundle-empty", tools: [] }),
    });
    expect(create.status).toBe(201);

    const res = await fetch(`${baseUrl}/admin-api/bundles/install-link-bundle-empty/install-links`, {
      method: "POST",
      headers: bearer(),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("EMPTY_BUNDLE");
  });

  test("501 when SECRET_ENCRYPTION_KEY is not configured", async () => {
    await startApp(false);
    await createBundleWithTool("install-link-bundle-nosecret", "install-link-svc-nosecret");

    const res = await fetch(`${baseUrl}/admin-api/bundles/install-link-bundle-nosecret/install-links`, {
      method: "POST",
      headers: bearer(),
    });
    expect(res.status).toBe(501);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("SECRET_BOX_NOT_CONFIGURED");
  });

  test("requires auth", async () => {
    await startApp();
    const res = await fetch(`${baseUrl}/admin-api/bundles/whatever/install-links`, { method: "POST" });
    expect(res.status).toBe(401);
  });

  test("a viewer-role session gets 403 creating an install link", async () => {
    await startApp();
    await createBundleWithTool("install-link-bundle-viewer", "install-link-svc-viewer");
    const viewer = createUser("install-link-viewer", "irrelevant-hash", "viewer", null);
    const session = createSession(viewer.id, "127.0.0.1", "test-agent");

    const res = await fetch(`${baseUrl}/admin-api/bundles/install-link-bundle-viewer/install-links`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `${SESSION_COOKIE_NAME}=${session.token}; ${CSRF_COOKIE_NAME}=${session.csrfToken}`,
        "X-CSRF-Token": session.csrfToken,
      },
    });
    expect(res.status).toBe(403);
  });
});

describe("GET /install/:token (public)", () => {
  async function mint(bundleName: string, clientName: string): Promise<string> {
    await createBundleWithTool(bundleName, clientName);
    const res = await fetch(`${baseUrl}/admin-api/bundles/${bundleName}/install-links`, {
      method: "POST",
      headers: bearer(),
    });
    const body = (await res.json()) as { token: string };
    return body.token;
  }

  test("a valid token returns bundle detail plus a ready-to-use connection snippet with the scoped key embedded", async () => {
    await startApp();
    const token = await mint("install-link-bundle-b", "install-link-svc-b");

    const res = await fetch(`${baseUrl}/install/${token}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      bundle: {
        name: string;
        description: string | null;
        tools: { client: string; tool: string; description: string }[];
      };
      connect: { filename: string; snippet: string; instructions: string[] };
    };
    expect(body.bundle.name).toBe("install-link-bundle-b");
    expect(body.bundle.tools).toEqual([
      { client: "install-link-svc-b", tool: "install-link-tool", description: "Returns a list of things" },
    ]);
    expect(body.connect.snippet).toContain("install-link-bundle-b");
    // The snippet must carry a REAL, usable bearer key (not a placeholder like
    // "<YOUR_MCP_API_KEY>") — the whole feature is a config that works with no
    // further steps — and it must be an mcp-key-store key (`mcp_` prefix),
    // never the admin's own bearer credential (ADMIN_KEY) used to mint it.
    expect(body.connect.snippet).toContain("mcp_");
    expect(body.connect.snippet).not.toContain(ADMIN_KEY);
    expect(body.connect.snippet).not.toContain("YOUR_MCP_API_KEY");
  });

  test("404 for an unknown token", async () => {
    await startApp();
    const res = await fetch(`${baseUrl}/install/bil_totally-made-up`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("INSTALL_LINK_NOT_FOUND");
  });

  test("404 after the link is revoked, and the underlying MCP key is also revoked", async () => {
    await startApp();
    await createBundleWithTool("install-link-bundle-c", "install-link-svc-c");
    const createRes = await fetch(`${baseUrl}/admin-api/bundles/install-link-bundle-c/install-links`, {
      method: "POST",
      headers: bearer(),
    });
    const created = (await createRes.json()) as { id: number; token: string; mcpKeyId: number };

    const before = await fetch(`${baseUrl}/install/${created.token}`);
    expect(before.status).toBe(200);

    const revokeRes = await fetch(`${baseUrl}/admin-api/bundles/install-link-bundle-c/install-links/${created.id}`, {
      method: "DELETE",
      headers: bearer(),
    });
    expect(revokeRes.status).toBe(200);

    const after = await fetch(`${baseUrl}/install/${created.token}`);
    expect(after.status).toBe(404);

    const keyRes = await fetch(`${baseUrl}/admin-api/mcp-keys/${created.mcpKeyId}`, { headers: bearer() });
    const key = (await keyRes.json()) as { revokedAt: number | null; enabled: boolean };
    expect(key.revokedAt).not.toBeNull();
    expect(key.enabled).toBe(false);
  });
});

describe("DELETE /admin-api/bundles/:name/install-links/:id", () => {
  test("404 for an unknown id", async () => {
    await startApp();
    await createBundleWithTool("install-link-bundle-d", "install-link-svc-d");
    const res = await fetch(`${baseUrl}/admin-api/bundles/install-link-bundle-d/install-links/424242`, {
      method: "DELETE",
      headers: bearer(),
    });
    expect(res.status).toBe(404);
  });

  test("409 when revoking an already-revoked link, and audits the revoke", async () => {
    await startApp();
    await createBundleWithTool("install-link-bundle-e", "install-link-svc-e");
    const createRes = await fetch(`${baseUrl}/admin-api/bundles/install-link-bundle-e/install-links`, {
      method: "POST",
      headers: bearer(),
    });
    const created = (await createRes.json()) as { id: number };

    const first = await fetch(`${baseUrl}/admin-api/bundles/install-link-bundle-e/install-links/${created.id}`, {
      method: "DELETE",
      headers: bearer(),
    });
    expect(first.status).toBe(200);
    const second = await fetch(`${baseUrl}/admin-api/bundles/install-link-bundle-e/install-links/${created.id}`, {
      method: "DELETE",
      headers: bearer(),
    });
    expect(second.status).toBe(409);

    const auditRes = await fetch(`${baseUrl}/admin-api/audit-log`, { headers: bearer() });
    const audit = (await auditRes.json()) as { items: { action: string; target: string }[] };
    expect(
      audit.items.some((e) => e.action === "bundle.install_link.revoke" && e.target === "install-link-bundle-e"),
    ).toBe(true);
  });
});

describe("DELETE /admin-api/bundles/:name cascades to install links", () => {
  test("deleting a bundle also revokes any still-active install link's MCP key", async () => {
    await startApp();
    await createBundleWithTool("install-link-bundle-f", "install-link-svc-f");
    const createRes = await fetch(`${baseUrl}/admin-api/bundles/install-link-bundle-f/install-links`, {
      method: "POST",
      headers: bearer(),
    });
    const created = (await createRes.json()) as { mcpKeyId: number };

    const delRes = await fetch(`${baseUrl}/admin-api/bundles/install-link-bundle-f`, {
      method: "DELETE",
      headers: bearer(),
    });
    expect(delRes.status).toBe(200);

    const keyRes = await fetch(`${baseUrl}/admin-api/mcp-keys/${created.mcpKeyId}`, { headers: bearer() });
    const key = (await keyRes.json()) as { revokedAt: number | null };
    expect(key.revokedAt).not.toBeNull();
  });
});
