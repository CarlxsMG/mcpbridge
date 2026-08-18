/**
 * End-to-end smoke test for the exact happy path the README/demo sells:
 *
 *   1. Log in to the admin UI with the bootstrap admin account.
 *   2. Register a REST backend discovered from an OpenAPI doc (the repo's
 *      existing fixtures/simple-openapi.json, served locally by
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
import { DEMO_SERVER_NAME, FIXTURE_BASE_URL } from "./support/env";
import { adminAuthHeaders, login, mintMcpKey, openAdvancedSettings } from "./support/admin";
import { closeTrackedMcpSessions, initMcpSession, mcpToolsCall } from "./support/mcp";

// Release the session this spec establishes back to the process-wide
// `maxSessions` budget. One session is not much on its own, but the suite
// shares a single 100-slot budget across every spec file and sessions outlive
// the run at a 30-minute TTL, so "not much" repeated per spec is what turns
// into a later spec's unexplained 503.
test.afterAll(closeTrackedMcpSessions);

test("login -> register a REST backend from OpenAPI -> call the discovered tool via MCP", async ({ page, request }) => {
  // ── (a) Log in ────────────────────────────────────────────────────────────
  await login(page);

  // ── (b) Register a REST backend, discovered from an OpenAPI doc ────────────
  await page.locator("#sidebar-nav").getByRole("link", { name: "Servers", exact: true }).click();
  await expect(page).toHaveURL(/\/admin\/servers$/);
  await page.getByRole("link", { name: "Add server" }).click();
  await expect(page).toHaveURL(/\/admin\/servers\/new$/);

  // The form leads with one field. A URL ending in .json autodetects as an
  // OpenAPI URL, and the name + health URL are derived from its host — both
  // stated on the page and editable under "Advanced settings", which is where
  // this spec pins its own server name. The source is named "OpenAPI URL", not
  // "OpenAPI document", precisely so that pasting a document is visibly not it.
  await page.locator("#r-source").fill(`${FIXTURE_BASE_URL}/openapi.json`);
  await expect(page.getByText("Detected: OpenAPI URL")).toBeVisible();
  await openAdvancedSettings(page);
  await page.locator("#r-name").fill(DEMO_SERVER_NAME);
  await page.locator("#r-health").fill(`${FIXTURE_BASE_URL}/health`);

  await page.getByRole("button", { name: "Preview tools" }).click();
  // Matches either branch of the pluralized message — see support/admin.ts.
  await expect(page.getByText(/tools? discovered/)).toBeVisible();
  await expect(page.locator("#preview-table")).toContainText("list-users");

  await page.getByRole("button", { name: "Register server" }).click();

  // ── (b2) The connect step, in place, without a trip to the Keys page ───────
  // The client config is already on screen; one button mints a key scoped to
  // the new server and substitutes it into the snippet. (Minting is a click, not
  // an on-render side effect — see 00-auth-fail-closed.spec.ts, whose open-mode
  // premise the first key minted anywhere in the suite would end.)
  await expect(page.getByRole("heading", { name: `${DEMO_SERVER_NAME} is registered` })).toBeVisible();
  const snippet = page.locator(".snippet");
  await expect(snippet).toContainText(`/mcp/${DEMO_SERVER_NAME}`);
  await expect(snippet).toContainText("<YOUR_MCP_API_KEY>");

  await page.getByRole("button", { name: "Create an API key for this server" }).click();
  await expect(snippet).not.toContainText("<YOUR_MCP_API_KEY>");
  await expect(snippet).toContainText(`/mcp/${DEMO_SERVER_NAME}`);

  await page.getByRole("link", { name: "Go to server" }).click();
  await expect(page).toHaveURL(new RegExp(`/admin/servers/${DEMO_SERVER_NAME}$`));
  await expect(page.locator("h1")).toHaveText(DEMO_SERVER_NAME);
  await expect(page.locator("#tools-table")).toContainText("list-users");

  // ── (c) Mint a managed MCP key so the data plane is in a known auth state ─
  // The data plane is fail-closed once any auth material exists. To keep
  // this spec independent of the order in which the e2e suite runs, mint
  // a fresh key here and use it for the data-plane call below.
  const auth = await adminAuthHeaders(page);
  const { authHeader } = await mintMcpKey(request, auth, "e2e-smoke");

  // ── (d) Call the discovered tool via the MCP data plane (raw JSON-RPC) ────
  // The data plane is one client per session — /mcp/<clientName>. The /mcp
  // root is the control plane and requires rootMcpAuth (a managed MCP key
  // with adminRole, or the env admin Bearer); this test exercises the
  // data-plane surface using the freshly-minted key from step (c).
  const dataPlane = `/mcp/${DEMO_SERVER_NAME}`;
  const toolName = `${DEMO_SERVER_NAME}__list-users`;
  const { sessionId } = await initMcpSession(dataPlane, { authHeader, clientName: "e2e-smoke" });
  const call = await mcpToolsCall(dataPlane, sessionId, toolName, authHeader);

  expect(call.status).toBe(200);
  expect(call.isError).toBeFalsy();
  expect(call.text).toContain("Ada Lovelace");
});
