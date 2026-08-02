/**
 * End-to-end test for the MCP auth "fail-closed" contract.
 *
 * ── THE `00-` PREFIX IS LOAD-BEARING ────────────────────────────────────────
 * The first assertion below requires that NO managed MCP key exists yet: the
 * data plane's "open mode" is a property of the whole process, and the first
 * key minted anywhere in the suite ends it permanently. Playwright runs spec
 * files in path-sorted order (workers: 1, fullyParallel: false), so this file
 * has to sort first, and the numeric prefix is what guarantees that rather
 * than the alphabetical luck the name used to rely on. Several sibling specs
 * (audit-trail, accessibility, bundles, ...) mint keys and would otherwise
 * silently invalidate the open-mode premise — the failure surfaces here, one
 * file away from its cause, as an unexplained 401 on a request that should
 * have been allowed.
 *
 * What this exercises that the existing smoke test does not:
 *
 *   - The data plane (`/mcp/:clientName`) starts in "open mode" while no
 *     auth material is configured (no env MCP_API_KEYS, no managed keys,
 *     no JWT verifier). Minting a managed key via the admin API must
 *     immediately lock the surface down — a request without auth is
 *     401, a request with a bogus token is 403, and only the right key
 *     gets through.
 *   - Revoking a key must remove its access: the same key returns 403
 *     after revocation.
 *
 * The control plane (`/mcp`) is gated by rootMcpAuth, which is fail-closed
 * by construction (no "open mode" fallback there). That story is covered
 * by src/__tests__/system-role.test.ts; this file focuses on the data
 * plane, where the open-mode-to-fail-closed transition is observable.
 */
import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { APP_BASE_URL } from "./support/env";
import {
  type AdminAuth,
  adminAuthHeaders,
  login,
  mintMcpKey,
  registerFixtureServer,
  revokeMcpKey,
} from "./support/admin";

/** Unique server name per spec run so this file can run alongside smoke.spec.ts. */
const SERVER_NAME = "e2e-auth-fail-closed-api";

interface McpAuthCall {
  status: number;
  /** Best-effort body — only present when we expected 200 (or the body was JSON). */
  bodyText?: string;
  /** The `mcp-session-id` response header, set on a successful initialize. */
  sessionId: string | null;
  _allHeaders?: Record<string, string>;
}

/** Calls the data plane's POST without a session. We just want the auth verdict. */
async function dataPlanePost(authHeader: string | null, serverName: string): Promise<McpAuthCall> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  if (authHeader) headers.authorization = authHeader;
  // Initialize-then-call counts as one round trip; the auth verdict is decided
  // before the handler runs, so a single initialize is enough to assert.
  const res = await fetch(`${APP_BASE_URL}/mcp/${serverName}`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "initialize",
      id: 1,
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "e2e-auth", version: "1.0" },
      },
    }),
  });
  // Snapshot headers BEFORE reading the body — `res.text()` is a one-shot
  // stream reader and on some platforms (and on error responses that
  // short-circuit before headers are flushed) this ordering matters.
  const allHeaders: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    allHeaders[k] = v;
  });
  return {
    status: res.status,
    bodyText: await res.text(),
    sessionId: res.headers.get("mcp-session-id"),
    _allHeaders: allHeaders,
  };
}

test.describe("MCP data plane — fail-closed lock-down after a managed key is minted", () => {
  let page: Page;
  let request: APIRequestContext;
  let auth: AdminAuth;
  let rawKey: string;
  let keyId: number;

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    request = page.context().request;
    await login(page);
    auth = await adminAuthHeaders(page);
    await registerFixtureServer(page, SERVER_NAME);
  });

  test.afterAll(async () => {
    await page.close();
  });

  test("minting a key transitions the data plane from open mode to auth-required", async () => {
    // Sanity check: before the key, the data plane is open (no auth material
    // configured). A request without Authorization gets a real MCP initialize
    // response (status 200 with a session-id header).
    const before = await dataPlanePost(null, SERVER_NAME);
    expect(before.status).toBe(200);
    // The bridge sets the mcp-session-id header on a successful Streamable
    // HTTP initialize — same as the smoke test's initMcpSession asserts.
    expect(before.sessionId, `headers: ${JSON.stringify(before._allHeaders)}, body: ${before.bodyText}`).toBeTruthy();

    // Mint a key — this is the moment the surface locks down.
    const minted = await mintMcpKey(request, auth, "e2e-auth-fail-closed");
    rawKey = minted.key;
    keyId = minted.id;
    expect(rawKey).toMatch(/^mcp_/);
    expect(keyId).toBeGreaterThan(0);
  });

  test("no Authorization header now returns 401 UNAUTHORIZED", async () => {
    const res = await dataPlanePost(null, SERVER_NAME);
    expect(res.status).toBe(401);
    const body = JSON.parse(res.bodyText ?? "{}") as { error?: { code?: string } };
    expect(body.error?.code).toBe("UNAUTHORIZED");
  });

  test("a bogus Bearer returns 403 FORBIDDEN (credential offered, rejected)", async () => {
    const res = await dataPlanePost("Bearer mcp_definitely-not-a-real-key", SERVER_NAME);
    expect(res.status).toBe(403);
    const body = JSON.parse(res.bodyText ?? "{}") as { error?: { code?: string } };
    expect(body.error?.code).toBe("FORBIDDEN");
  });

  test("the freshly-minted key is accepted (and the data plane still works end-to-end)", async () => {
    const res = await dataPlanePost(`Bearer ${rawKey}`, SERVER_NAME);
    expect(res.status).toBe(200);
    expect(res.sessionId).toBeTruthy();
  });

  test("revoking the key removes its access (subsequent call returns 403)", async () => {
    await revokeMcpKey(request, auth, keyId);

    const res = await dataPlanePost(`Bearer ${rawKey}`, SERVER_NAME);
    expect(res.status).toBe(403);
    const body = JSON.parse(res.bodyText ?? "{}") as { error?: { code?: string } };
    expect(body.error?.code).toBe("FORBIDDEN");
  });
});
