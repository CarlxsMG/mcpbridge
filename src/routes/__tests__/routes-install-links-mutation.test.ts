/**
 * Stryker mutation-testing backstop for src/routes/install-links.ts —
 * domain 8. The baseline run found the existing
 * routes-bundle-install-links.test.ts covers the valid/unknown/revoked
 * token happy paths well, but never varies config.gatewayPublicUrl,
 * never sends a request without one (to exercise the host-derived
 * fallback), never checks the exact 404 message, never asserts the
 * gateway URL's exact "bundle" scope shape, never checks the transport
 * field embedded in the snippet, and never exercises a tool missing from
 * the live registry (the ?? "" description fallback).
 *
 * Each group below names the EXPRESSION its mutants live in rather than
 * a line:col from reports/mutation/result.json — those coordinates go
 * stale the moment the source file gains or loses a line, and a stale
 * citation is worse than none.
 *
 * Two survivors are accepted EQUIVALENTS, not chased with dedicated
 * tests:
 * - The `${req.protocol}://localhost` fallback in resolveGatewayBaseUrl,
 *   taken when `req.get("host")` is falsy. Every real HTTP/1.1 request
 *   carries a mandatory Host header (RFC 7230 §5.4) and Node's own
 *   `http`/`fetch` clients always send one automatically; there is no
 *   practical way to construct a real client request that omits it,
 *   making this branch unreachable via any HTTP call this test suite
 *   (or any client) can make.
 * - The `?? ""` description fallback in describeBundleTools, replaced
 *   with a truthy placeholder — see the comment above that test group
 *   below for the full FK-constraint-based proof that a bundle can
 *   never contain a tool reference absent from the `tools` table.
 */
import { describe, test, expect, spyOn } from "bun:test";
import { clearRegistry } from "../../__tests__/_utils/registry.js";
import { listen, closeServer } from "../../__tests__/_utils/app.js";
import { jsonBearerHeaders, setAdminApiKeys } from "../../__tests__/_utils/admin-auth.js";
import express from "express";
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
  setAdminApiKeys([ADMIN_KEY]);
  (config as Record<string, unknown>).authDisabled = false;
  (config as Record<string, unknown>).secretEncryptionKey = Buffer.alloc(32, 6).toString("base64");
  const { adminRoutes } = await import("../../routes/admin.js");
  const { installLinkRoutes } = await import("../../routes/install-links.js");
  const app = express();
  app.use(express.json());
  app.use(requestIdMiddleware);
  adminRoutes(app);
  installLinkRoutes(app);
  return listen(app);
}

const bearer = (): Record<string, string> => jsonBearerHeaders(ADMIN_KEY);

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
    await clearRegistry();
    (config as Record<string, unknown>).secretEncryptionKey = originalSecretKey;
    (config as Record<string, unknown>).gatewayPublicUrl = originalGatewayPublicUrl;
    await closeServer(server);
  }
}

describe("GET /install/:token — gateway base URL resolution", () => {
  // Kills the ConditionalExpression mutant on resolveGatewayBaseUrl's
  // `if (config.gatewayPublicUrl)` (forced 'false', so a genuinely
  // configured public URL would never be used).
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

  // Kills the StringLiteral mutant that empties the
  // `${req.protocol}://${host}` template -- with no gatewayPublicUrl
  // configured, the real request's own Host header must be reflected in
  // the generated URL.
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
  // Kills the StringLiteral mutant that empties the 404's exact message.
  test("404 for an unknown token carries the exact message", async () => {
    await withApp(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/install/no-such-token`);
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("INSTALL_LINK_NOT_FOUND");
      expect(body.error.message).toBe("This install link is invalid or no longer available");
    });
  });

  // Kills the StringLiteral mutant that empties the "bundle" scope literal
  // passed to resolveGatewayEndpoint, which would make it fall through to
  // the bare /mcp control-plane URL instead of /mcp-custom/<bundle-name>.
  test("the connect URL uses the bundle-scoped /mcp-custom/<name> path", async () => {
    await withApp(async (baseUrl) => {
      const token = await mint(baseUrl, "install-link-mut-scope", "install-link-mut-scope-svc");
      const res = await fetch(`${baseUrl}/install/${token}`);
      const body = (await res.json()) as { connect: { snippet: string } };
      expect(body.connect.snippet).toContain("/mcp-custom/install-link-mut-scope");
    });
  });

  // Kills the StringLiteral mutant that empties the "streamable-http"
  // transport value -- it's embedded verbatim in the generated JSON snippet.
  test("the connect snippet embeds the exact streamable-http transport", async () => {
    await withApp(async (baseUrl) => {
      const token = await mint(baseUrl, "install-link-mut-transport", "install-link-mut-transport-svc");
      const res = await fetch(`${baseUrl}/install/${token}`);
      const body = (await res.json()) as { connect: { snippet: string } };
      expect(body.connect.snippet).toContain("streamable-http");
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// This route is PUBLIC — no adminAuth — so the work it does per request must
// not scale with the size of the deployment's catalog. It used to describe a
// bundle's handful of tools by materialising registry.listAllTools(), which
// reads every row of `tools` plus every tool tag.
// ─────────────────────────────────────────────────────────────────────────
describe("GET /install/:token — describes only the bundle's own tools", () => {
  const A = "install-link-scoped-a";
  const B = "install-link-scoped-b";
  const C = "install-link-scoped-c";
  const BUNDLE = "install-link-scoped-bundle";
  // Big enough that a whole-catalog read is unmistakably wider than the
  // two-row answer; small enough to stay cheap in a suite of 370+ files.
  const NOISE_PER_CLIENT = 60;

  function noiseTools(clientTag: string): RestToolDefinition[] {
    return Array.from({ length: NOISE_PER_CLIENT }, (_, i) =>
      makeTool({ name: `noise-${i}`, description: `zznoise-${clientTag}-${i}` }),
    );
  }

  async function seedAndMint(baseUrl: string): Promise<string> {
    await reg(A, [makeTool({ name: "picked-a", description: "zzpicked-alpha" }), ...noiseTools("a")]);
    await reg(B, [makeTool({ name: "picked-b", description: "zzpicked-beta" }), ...noiseTools("b")]);
    await reg(C, noiseTools("c"));
    await fetch(`${baseUrl}/admin-api/bundles`, {
      method: "POST",
      headers: bearer(),
      body: JSON.stringify({
        name: BUNDLE,
        tools: [
          { client: A, tool: "picked-a" },
          { client: B, tool: "picked-b" },
        ],
      }),
    });
    const res = await fetch(`${baseUrl}/admin-api/bundles/${BUNDLE}/install-links`, {
      method: "POST",
      headers: bearer(),
    });
    return ((await res.json()) as { token: string }).token;
  }

  test("returns exactly the bundle's tools with their real descriptions, and nothing else from the catalog", async () => {
    await withApp(async (baseUrl) => {
      const token = await seedAndMint(baseUrl);
      const res = await fetch(`${baseUrl}/install/${token}`);
      expect(res.status).toBe(200);
      const raw = await res.text();
      const body = JSON.parse(raw) as {
        bundle: { tools: { client: string; tool: string; description: string }[] };
      };
      // The positive signal: the real stored descriptions, in the bundle's own
      // (client, tool) order — not the absence of an error. A scoped lookup
      // that silently missed would show up here as an empty description.
      expect(body.bundle.tools).toEqual([
        { client: A, tool: "picked-a", description: "zzpicked-alpha" },
        { client: B, tool: "picked-b", description: "zzpicked-beta" },
      ]);
      // And nothing from the 180 catalog rows the bundle does not name — not
      // even from client C, which contributes no tool to it at all.
      expect(raw).not.toContain("zznoise");
      expect(raw).not.toContain(C);
    });
  });

  test("never calls the whole-catalog read model", async () => {
    await withApp(async (baseUrl) => {
      const token = await seedAndMint(baseUrl);
      // The strongest evidence available for the O(bundle) property: the only
      // broad accessor this route ever used. Restored in `finally` because the
      // registry singleton is shared by every later test in the process.
      const listAll = spyOn(registry, "listAllTools");
      try {
        const res = await fetch(`${baseUrl}/install/${token}`);
        expect(res.status).toBe(200);
        expect(listAll).not.toHaveBeenCalled();
      } finally {
        listAll.mockRestore();
      }
    });
  });
});

// The `?? ""` fallback in describeBundleTools (replaced with a truthy
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
// So a bundle can never contain a {client, tool} pair absent from the
// `tools` table — describeBundleTools' per-pair lookup can never miss for
// a real bundle.tools entry, making the `?? ""` fallback unreachable by
// construction, not just hard to trigger. (That argument is about SQLite,
// which is why the lookup reads `tools.description` rather than the live
// registry map: a bundle CAN name a tool whose client is not currently
// live, and the in-memory map holds nothing for it.)
