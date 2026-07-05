/**
 * End-to-end smoke test for the exact happy path the README/demo sells:
 *
 *   1. Log in to the admin UI with the bootstrap admin account.
 *   2. Register a REST backend discovered from an OpenAPI doc (the repo's
 *      existing tests/fixtures/simple-openapi.json, served locally by
 *      global-setup.ts) and confirm it shows up with its discovered tool.
 *   3. Call that discovered tool directly against the MCP endpoint with a
 *      raw JSON-RPC Streamable HTTP request (initialize -> tools/call),
 *      following the same envelope shape used by
 *      src/__tests__/transports-bundle.test.ts, and assert the call
 *      actually reaches the fixture backend and returns its data.
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

/** Performs the real MCP initialize handshake against `path`. Returns the session id. */
async function initMcpSession(path: string): Promise<string> {
  const initRes = await fetch(`${APP_BASE_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
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
    },
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  });

  return sessionId;
}

async function mcpToolsCall(
  path: string,
  sessionId: string,
  toolName: string,
): Promise<{ status: number; isError?: boolean; text?: string }> {
  const res = await fetch(`${APP_BASE_URL}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-session-id": sessionId,
    },
    body: JSON.stringify({ jsonrpc: "2.0", method: "tools/call", id: 2, params: { name: toolName, arguments: {} } }),
  });
  if (res.status !== 200) return { status: res.status };
  const parsed = parseSseJson(await res.text());
  const result = parsed.result as { isError?: boolean; content?: { type: string; text: string }[] } | undefined;
  return { status: res.status, isError: result?.isError, text: result?.content?.map((c) => c.text).join("\n") };
}

test("login -> register a REST backend from OpenAPI -> call the discovered tool via MCP", async ({ page }) => {
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

  // ── (c) Call the discovered tool via the MCP endpoint (raw JSON-RPC) ───────
  const toolName = `${DEMO_SERVER_NAME}__list-users`;
  const sessionId = await initMcpSession("/mcp");
  const call = await mcpToolsCall("/mcp", sessionId, toolName);

  expect(call.status).toBe(200);
  expect(call.isError).toBeFalsy();
  expect(call.text).toContain("Ada Lovelace");
});
