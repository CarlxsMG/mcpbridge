/**
 * End-to-end smoke test for the exact happy path the README/demo sells:
 *
 *   1. Log in to the admin UI with the bootstrap admin account.
 *   2. Register a REST backend discovered from an OpenAPI doc (the repo's
 *      existing tests/fixtures/simple-openapi.json, served locally by
 *      global-setup.ts) and confirm it shows up with its discovered tool.
 *   3. Mint a managed MCP key (so the data plane is in a known
 *      auth-required state, independent of any other spec that ran first).
 *   4. Call that discovered tool directly against the MCP **data plane** with
 *      a raw JSON-RPC Streamable HTTP request (initialize -> tools/call),
 *      following the same envelope shape used by
 *      src/__tests__/transports-bundle.test.ts, and assert the call actually
 *      reaches the fixture backend and returns its data.
 *
 * The data plane is `/mcp/:clientName` (one client per session). The `/mcp`
 * root is the control plane (sys_* tools) and is now gated by rootMcpAuth,
 * which is not what this test exercises — see `auth-fail-closed.spec.ts` for
 * the control-plane auth story.
 */
import { test, expect } from "@playwright/test";
import {
  APP_BASE_URL,
  BOOTSTRAP_ADMIN_PASSWORD,
  BOOTSTRAP_ADMIN_USERNAME,
  DEMO_SERVER_NAME,
  FIXTURE_BASE_URL,
} from "./env";

/** Parses the `data: {...}` line out of an MCP Streamable HTTP SSE-framed response body. */
function parseSseJson(text: string): { result?: unknown; error?: unknown; id?: unknown } {
  const match = text.match(/data: (.+)/);
  if (!match) throw new Error(`Could not parse SSE body: ${text}`);
  return JSON.parse(match[1]);
}

/** Performs the real MCP initialize handshake against `path` with the given Bearer. Returns the session id. */
async function initMcpSession(path: string, authHeader: string): Promise<string> {
  const initRes = await fetch(`${APP_BASE_URL}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: authHeader,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "initialize",
      id: 1,
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e-smoke", version: "1.0" } },
    }),
  });
  const sessionId = initRes.headers.get("mcp-session-id");
  if (initRes.status !== 200 || !sessionId) {
    throw new Error(`MCP initialize failed: status=${initRes.status} body=${await initRes.text()}`);
  }

  await fetch(`${APP_BASE_URL}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-session-id": sessionId,
      authorization: authHeader,
    },
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  });

  return sessionId;
}

async function mcpToolsCall(
  path: string,
  sessionId: string,
  toolName: string,
  authHeader: string,
  args: Record<string, unknown> = {},
): Promise<{ status: number; isError?: boolean; text?: string }> {
  const res = await fetch(`${APP_BASE_URL}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-session-id": sessionId,
      authorization: authHeader,
    },
    body: JSON.stringify({ jsonrpc: "2.0", method: "tools/call", id: 2, params: { name: toolName, arguments: args } }),
  });
  if (res.status !== 200) return { status: res.status };
  const parsed = parseSseJson(await res.text());
  const result = parsed.result as { isError?: boolean; content?: { type: string; text: string }[] } | undefined;
  return { status: res.status, isError: result?.isError, text: result?.content?.map((c) => c.text).join("\n") };
}

test("login -> register a REST backend from OpenAPI -> call the discovered tool via MCP", async ({ page, request }) => {
  // ── (a) Log in ────────────────────────────────────────────────────────────
  await page.goto("/admin/login");
  await page.locator("#username").fill(BOOTSTRAP_ADMIN_USERNAME);
  await page.locator("#password").fill(BOOTSTRAP_ADMIN_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Servers" })).toBeVisible();

  // ── (b) Register a REST backend, discovered from an OpenAPI doc ────────────
  await page.locator("#sidebar-nav").getByRole("link", { name: "Add server" }).click();
  await expect(page).toHaveURL(/\/admin\/register-server$/);

  await page.locator("#r-name").fill(DEMO_SERVER_NAME);
  await page.locator("#r-health").fill(`${FIXTURE_BASE_URL}/health`);
  await page.locator("#r-openapi").fill(`${FIXTURE_BASE_URL}/openapi.json`);

  await page.getByRole("button", { name: "Preview tools" }).click();
  await expect(page.getByText(/tool\(s\) discovered/)).toBeVisible();
  await expect(page.locator("#preview-table")).toContainText("list-users");

  await page.getByRole("button", { name: "Register server" }).click();
  await expect(page).toHaveURL(new RegExp(`/admin/servers/${DEMO_SERVER_NAME}$`));
  await expect(page.locator("h1")).toHaveText(DEMO_SERVER_NAME);
  await expect(page.locator("#tools-table")).toContainText("list-users");

  // ── (c) Mint a managed MCP key so the data plane is in a known auth state ─
  // The data plane is fail-closed once any auth material exists. To keep
  // this spec independent of the order in which the e2e suite runs, mint
  // a fresh key here and use it for the data-plane call below.
  const cookies = await page.context().cookies();
  const cookieHeader = `mcp_admin_session=${cookies.find((c) => c.name === "mcp_admin_session")?.value ?? ""}`;
  const csrfHeader =
    cookies.find((c) => c.name === "mcp_admin_csrf" || c.name === "__Host-mcp_admin_csrf")?.value ?? "";
  const minted = await request.post(`${APP_BASE_URL}/admin-api/mcp-keys`, {
    headers: { cookie: cookieHeader, "x-csrf-token": csrfHeader, "content-type": "application/json" },
    data: { label: "e2e-smoke", scopes: null, expiresAt: null, consumerId: null, elevated: false, adminRole: null },
  });
  expect(minted.status(), `mcp-key create failed: ${await minted.text()}`).toBe(201);
  const bearer = (await minted.json()) as { key: string };
  const authHeader = `Bearer ${bearer.key}`;

  // ── (d) Call the discovered tool via the MCP data plane (raw JSON-RPC) ────
  // The data plane is one client per session — /mcp/<clientName>. The /mcp
  // root is the control plane and requires rootMcpAuth (a managed MCP key
  // with adminRole, or the env admin Bearer); this test exercises the
  // data-plane surface using the freshly-minted key from step (c).
  const dataPlane = `/mcp/${DEMO_SERVER_NAME}`;
  const toolName = `${DEMO_SERVER_NAME}__list-users`;
  const sessionId = await initMcpSession(dataPlane, authHeader);
  const call = await mcpToolsCall(dataPlane, sessionId, toolName, authHeader);

  expect(call.status).toBe(200);
  expect(call.isError).toBeFalsy();
  expect(call.text).toContain("Ada Lovelace");
});
