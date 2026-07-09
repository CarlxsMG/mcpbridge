/**
 * Stryker mutation-testing backstop for src/routes/install-links.ts —
 * domain 8. Baseline: 29 mutants, 22 killed / 7 survived — the existing
 * routes-bundle-install-links.test.ts covers the valid/unknown/revoked
 * token happy paths well, but never varies config.gatewayPublicUrl,
 * never sends a request without one (to exercise the host-derived
 * fallback), never checks the exact 404 message, never asserts the
 * gateway URL's exact "bundle" scope shape, never checks the transport
 * field embedded in the snippet, and never exercises a tool missing from
 * the live registry (the ?? "" description fallback). All line:col
 * citations below were read directly from reports/mutation/result.json.
 *
 * Two survivors are accepted EQUIVALENTS, not chased with dedicated
 * tests:
 * - 13:47-76 StringLiteral (the `${req.protocol}://localhost` fallback,
 *   taken when `req.get("host")` is falsy). Every real HTTP/1.1 request
 *   carries a mandatory Host header (RFC 7230 §5.4) and Node's own
 *   `http`/`fetch` clients always send one automatically; there is no
 *   practical way to construct a real client request that omits it,
 *   making this branch unreachable via any HTTP call this test suite
 *   (or any client) can make.
 * - 59:72-74 StringLiteral (the `?? ""` description fallback replaced
 *   with a truthy placeholder) — see the comment above that test group
 *   below for the full FK-constraint-based proof that a bundle can
 *   never contain a tool reference absent from the live registry.
 */
import { describe, test, expect } from "bun:test";
import express from "express";
import type { AddressInfo } from "net";
import type { Server } from "http";
import { config } from "../../config.js";
import { __resetDbForTesting } from "../../db/connection.js";
import { registry } from "../../mcp/registry.js";
import { initBundles } from "../../admin/tool-composition/bundles.js";
import { requestIdMiddleware } from "../../middleware/request-id.js";
import { _internalsForTesting } from "../../middleware/rate-limiter.js";
import type { RestToolDefinition } from "../../mcp/types.js";

const ADMIN_KEY = "test-admin-key-install-links-mut";
const originalSecretKey = config.secretEncryptionKey;
const originalGatewayPublicUrl = config.gatewayPublicUrl;

async function startApp(): Promise<{ baseUrl: string; server: Server }> {
  __resetDbForTesting();
  initBundles();
  _internalsForTesting.installLinkBuckets.clear();
  (config as Record<string, unknown>).adminApiKeys = [ADMIN_KEY];
  (config as Record<string, unknown>).authDisabled = false;
  (config as Record<string, unknown>).secretEncryptionKey = Buffer.alloc(32, 6).toString("base64");
  const { bundleRoutes } = await import("../../routes/bundles.js");
  const { installLinkRoutes } = await import("../../routes/install-links.js");
  const app = express();
  app.use(express.json());
  app.use(requestIdMiddleware);
  bundleRoutes(app);
  installLinkRoutes(app);
  return new Promise((resolve, reject) => {
    const srv = app.listen(0, "127.0.0.1", () => {
      resolve({ baseUrl: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`, server: srv });
    });
    srv.on("error", reject);
  });
}

function bearer(): Record<string, string> {
  return { Authorization: `Bearer ${ADMIN_KEY}`, "Content-Type": "application/json" };
}

function makeTool(overrides: Partial<RestToolDefinition> = {}): RestToolDefinition {
  return {
    name: "install-link-mut-tool",
    method: "GET",
    endpoint: "/things",
    description: "a real description",
    inputSchema: { type: "object", properties: {} },
    ...overrides,
  };
}

async function reg(name: string, tools: RestToolDefinition[] = [makeTool()]): Promise<void> {
  await registry.register(name, tools, "http://example.com/health", "1.2.3.4", "http://example.com", "1.2.3.4");
}

async function mint(baseUrl: string, bundleName: string, clientName: string): Promise<string> {
  await reg(clientName);
  await fetch(`${baseUrl}/admin-api/bundles`, {
    method: "POST",
    headers: bearer(),
    body: JSON.stringify({ name: bundleName, tools: [{ client: clientName, tool: "install-link-mut-tool" }] }),
  });
  const res = await fetch(`${baseUrl}/admin-api/bundles/${bundleName}/install-links`, {
    method: "POST",
    headers: bearer(),
  });
  const body = (await res.json()) as { token: string };
  return body.token;
}

async function withApp(fn: (baseUrl: string) => Promise<void>): Promise<void> {
  const { baseUrl, server } = await startApp();
  try {
    await fn(baseUrl);
  } finally {
    for (const c of registry.listClients()) await registry.unregister(c.name);
    (config as Record<string, unknown>).secretEncryptionKey = originalSecretKey;
    (config as Record<string, unknown>).gatewayPublicUrl = originalGatewayPublicUrl;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe("GET /install/:token — gateway base URL resolution", () => {
  // Kills 11:7-30 ConditionalExpression 'false' (config.gatewayPublicUrl
  // forced to never be used, even when genuinely configured).
  test("uses the configured gatewayPublicUrl when set, not the request host", async () => {
    await withApp(async (baseUrl) => {
      const token = await mint(baseUrl, "install-link-mut-gw", "install-link-mut-gw-svc");
      (config as Record<string, unknown>).gatewayPublicUrl = "https://gw.configured.example";
      const res = await fetch(`${baseUrl}/install/${token}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { connect: { snippet: string } };
      expect(body.connect.snippet).toContain("https://gw.configured.example");
    });
  });

  // Kills 13:17-44 StringLiteral (the `${req.protocol}://${host}` template
  // emptied) -- with no gatewayPublicUrl configured, the real request's
  // own Host header must be reflected in the generated URL.
  test("falls back to the request's own protocol+host when gatewayPublicUrl is unset", async () => {
    await withApp(async (baseUrl) => {
      const token = await mint(baseUrl, "install-link-mut-host", "install-link-mut-host-svc");
      const res = await fetch(`${baseUrl}/install/${token}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { connect: { snippet: string } };
      const host = new URL(baseUrl).host;
      expect(body.connect.snippet).toContain(`http://${host}`);
    });
  });
});

describe("GET /install/:token — exact error message and snippet content", () => {
  // Kills 30:55-108 StringLiteral (the exact 404 message emptied).
  test("404 for an unknown token carries the exact message", async () => {
    await withApp(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/install/no-such-token`);
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("INSTALL_LINK_NOT_FOUND");
      expect(body.error.message).toBe("This install link is invalid or no longer available");
    });
  });

  // Kills 38:55-63 StringLiteral (the "bundle" scope literal emptied,
  // which would make resolveGatewayEndpoint fall through to the bare
  // /mcp control-plane URL instead of /mcp-custom/<bundle-name>).
  test("the connect URL uses the bundle-scoped /mcp-custom/<name> path", async () => {
    await withApp(async (baseUrl) => {
      const token = await mint(baseUrl, "install-link-mut-scope", "install-link-mut-scope-svc");
      const res = await fetch(`${baseUrl}/install/${token}`);
      const body = (await res.json()) as { connect: { snippet: string } };
      expect(body.connect.snippet).toContain("/mcp-custom/install-link-mut-scope");
    });
  });

  // Kills 48:20-37 StringLiteral (the "streamable-http" transport value
  // emptied) -- it's embedded verbatim in the generated JSON snippet.
  test("the connect snippet embeds the exact streamable-http transport", async () => {
    await withApp(async (baseUrl) => {
      const token = await mint(baseUrl, "install-link-mut-transport", "install-link-mut-transport-svc");
      const res = await fetch(`${baseUrl}/install/${token}`);
      const body = (await res.json()) as { connect: { snippet: string } };
      expect(body.connect.snippet).toContain("streamable-http");
    });
  });
});

// 59:72-74 StringLiteral (the `?? ""` fallback replaced with a truthy
// placeholder) is an accepted EQUIVALENT, not chased with a dedicated
// test. `bundle.tools` entries come from `mcp_bundle_tools`, which has a
// `FOREIGN KEY (client_name, tool_name) REFERENCES tools(client_name,
// name) ON DELETE CASCADE` (confirmed in src/db/migrations.ts) with
// `PRAGMA foreign_keys = ON` (src/db/connection.ts). Verified empirically
// with a throwaway bun:sqlite script reproducing the same schema: inserting
// a bundle_tools row for a client/tool NOT present in `tools` throws
// "FOREIGN KEY constraint failed", and deleting the underlying tool row
// (registry.forgetClient()) cascades to DELETE the bundle_tools row
// too (confirmed: bundle.tools became [], not a dangling reference).
// So a bundle can never contain a {client, tool} pair absent from
// registry.listAllTools() — descriptions.get(...) can never return
// undefined for a real bundle.tools entry, making the `?? ""` fallback
// unreachable by construction, not just hard to trigger.
