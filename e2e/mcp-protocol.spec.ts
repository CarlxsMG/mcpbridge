/**
 * End-to-end test for the MCP data-plane protocol contract.
 *
 * Exercises the same envelope that an MCP client (Claude Desktop, an IDE
 * plugin, a custom agent) would send against `/mcp/:clientName`:
 *
 *   - `initialize` handshake returns a session id and a serverInfo
 *     identifying the bridge.
 *   - `tools/list` advertises the registered client__tool shape, with the
 *     OpenAPI-derived name, description, and JSON-Schema-style inputSchema.
 *   - `tools/call` for a known tool returns the upstream payload; for an
 *     unknown tool, the bridge returns isError:true (NOT a transport-level
 *     error) so the agent can recover without dropping the session.
 *   - `tools/call` with arguments that fail the input schema returns a
 *     well-formed validation error envelope (isError:true with a
 *     human-readable message), not a 4xx.
 *
 * The fixture's `create-user` POST path returns 404 from the upstream
 * (the fake backend only handles GET /api/v1/users) — that's the right
 * shape to assert that a backend 404 becomes an isError MCP result, not
 * a transport error.
 */
import { test, expect, type Page } from "@playwright/test";
import { APP_BASE_URL, BOOTSTRAP_ADMIN_PASSWORD, BOOTSTRAP_ADMIN_USERNAME, FIXTURE_BASE_URL } from "./env";

/** Unique server name per spec run so this file can run alongside the others. */
const SERVER_NAME = "e2e-mcp-protocol-api";
const DATA_PLANE = `/mcp/${SERVER_NAME}`;

function parseSseJson(text: string): { result?: unknown; error?: unknown; id?: unknown } {
  const match = text.match(/data: (.+)/);
  if (!match) throw new Error(`Could not parse SSE body: ${text}`);
  return JSON.parse(match[1]);
}

async function loginAndRegister(page: Page): Promise<void> {
  await page.goto("/admin/login");
  await page.locator("#username").fill(BOOTSTRAP_ADMIN_USERNAME);
  await page.locator("#password").fill(BOOTSTRAP_ADMIN_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Servers" })).toBeVisible();

  await page.locator("#sidebar-nav").getByRole("link", { name: "Add server" }).click();
  await page.locator("#r-name").fill(SERVER_NAME);
  await page.locator("#r-health").fill(`${FIXTURE_BASE_URL}/health`);
  await page.locator("#r-openapi").fill(`${FIXTURE_BASE_URL}/openapi.json`);
  await page.getByRole("button", { name: "Preview tools" }).click();
  await expect(page.getByText(/tool\(s\) discovered/)).toBeVisible();
  await page.getByRole("button", { name: "Register server" }).click();
  await expect(page).toHaveURL(new RegExp(`/admin/servers/${SERVER_NAME}$`));
}

interface McpInit {
  sessionId: string;
  serverInfo: { name?: string; version?: string };
}

async function initSession(path: string, authHeader?: string): Promise<McpInit> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  if (authHeader) headers.authorization = authHeader;
  const initRes = await fetch(`${APP_BASE_URL}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "initialize",
      id: 1,
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "e2e-mcp-protocol", version: "1.0" },
      },
    }),
  });
  const sessionId = initRes.headers.get("mcp-session-id");
  if (initRes.status !== 200 || !sessionId) {
    throw new Error(`initialize failed: status=${initRes.status} body=${await initRes.text()}`);
  }
  const parsed = parseSseJson(await initRes.text());
  const result = parsed.result as { serverInfo?: { name?: string; version?: string } } | undefined;
  const notifHeaders: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "mcp-session-id": sessionId,
  };
  if (authHeader) notifHeaders.authorization = authHeader;
  await fetch(`${APP_BASE_URL}${path}`, {
    method: "POST",
    headers: notifHeaders,
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  });
  return { sessionId, serverInfo: result?.serverInfo ?? {} };
}

interface McpCallResult {
  status: number;
  isError?: boolean;
  text?: string;
}

async function mcpRequest(
  path: string,
  sessionId: string,
  body: Record<string, unknown>,
  authHeader: string,
): Promise<McpCallResult> {
  const res = await fetch(`${APP_BASE_URL}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-session-id": sessionId,
      authorization: authHeader,
    },
    body: JSON.stringify(body),
  });
  if (res.status !== 200) return { status: res.status };
  const parsed = parseSseJson(await res.text());
  const result = parsed.result as { isError?: boolean; content?: { type: string; text: string }[] } | undefined;
  return {
    status: res.status,
    isError: result?.isError,
    text: result?.content?.map((c) => c.text).join("\n"),
  };
}

test.describe("MCP data plane — protocol contract", () => {
  let page: Page;
  let request: APIRequestContext;
  let bearer: { key: string };

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    request = page.context().request;
    await loginAndRegister(page);

    // Mint a key so the data plane is in a known auth-required state and
    // this spec is independent of the order it runs in.
    const cookies = await page.context().cookies();
    const cookieHeader = `mcp_admin_session=${cookies.find((c) => c.name === "mcp_admin_session")?.value ?? ""}`;
    const csrfHeader =
      cookies.find((c) => c.name === "mcp_admin_csrf" || c.name === "__Host-mcp_admin_csrf")?.value ?? "";
    const minted = await request.post(`${APP_BASE_URL}/admin-api/mcp-keys`, {
      headers: { cookie: cookieHeader, "x-csrf-token": csrfHeader, "content-type": "application/json" },
      data: {
        label: "e2e-mcp-protocol",
        scopes: null,
        expiresAt: null,
        consumerId: null,
        elevated: false,
        adminRole: null,
      },
    });
    expect(minted.status(), `mcp-key create failed: ${await minted.text()}`).toBe(201);
    bearer = (await minted.json()) as { key: string };
  });

  test.afterAll(async () => {
    await page.close();
  });

  test("initialize advertises the bridge as the server (serverInfo.name)", async () => {
    const init = await initSession(DATA_PLANE, `Bearer ${bearer.key}`);
    expect(init.serverInfo.name).toBeTruthy();
  });

  test("tools/list advertises the discovered client__tool with the OpenAPI-derived name and schema", async () => {
    // Each test establishes its own session — the data plane's Streamable
    // HTTP transport keeps per-session state and reusing one across tests
    // races with the other e2e specs running serially in the same worker.
    const init = await initSession(DATA_PLANE, `Bearer ${bearer.key}`);
    const res = await fetch(`${APP_BASE_URL}${DATA_PLANE}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-session-id": init.sessionId,
        authorization: `Bearer ${bearer.key}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 2, params: {} }),
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    const parsed = parseSseJson(text);
    const tools = (parsed.result as { tools?: { name: string; description?: string; inputSchema?: unknown }[] })?.tools;
    expect(Array.isArray(tools)).toBe(true);
    const listUsers = tools?.find((t) => t.name === `${SERVER_NAME}__list-users`);
    expect(listUsers).toBeDefined();
    expect(listUsers?.description).toBe("List all users");
    // Schema should have a `limit` property from the OpenAPI parameter
    const schema = listUsers?.inputSchema as { properties?: { limit?: unknown } };
    expect(schema?.properties?.limit).toBeDefined();
  });

  test("tools/call for a known tool returns the upstream payload (no isError)", async () => {
    const init = await initSession(DATA_PLANE, `Bearer ${bearer.key}`);
    const call = await mcpRequest(
      DATA_PLANE,
      init.sessionId,
      {
        jsonrpc: "2.0",
        method: "tools/call",
        id: 3,
        params: { name: `${SERVER_NAME}__list-users`, arguments: {} },
      },
      `Bearer ${bearer.key}`,
    );
    expect(call.status).toBe(200);
    expect(call.isError).toBeFalsy();
    expect(call.text).toContain("Ada Lovelace");
  });

  test("tools/call for an unknown tool surfaces isError:true (does not drop the session)", async () => {
    const init = await initSession(DATA_PLANE, `Bearer ${bearer.key}`);
    const call = await mcpRequest(
      DATA_PLANE,
      init.sessionId,
      {
        jsonrpc: "2.0",
        method: "tools/call",
        id: 4,
        params: { name: `${SERVER_NAME}__no-such-tool`, arguments: {} },
      },
      `Bearer ${bearer.key}`,
    );
    expect(call.status).toBe(200);
    expect(call.isError).toBe(true);
    expect(call.text).toContain("Unknown tool");
  });

  test("tools/call with arguments that violate the input schema returns isError:true (not a transport error)", async () => {
    const init = await initSession(DATA_PLANE, `Bearer ${bearer.key}`);
    const call = await mcpRequest(
      DATA_PLANE,
      init.sessionId,
      {
        jsonrpc: "2.0",
        method: "tools/call",
        id: 5,
        params: { name: `${SERVER_NAME}__create-user`, arguments: {} },
      },
      `Bearer ${bearer.key}`,
    );
    expect(call.status).toBe(200);
    expect(call.isError).toBe(true);
    expect(call.text).toMatch(/validation|argument/i);
  });

  test("a backend 404 surfaces as isError:true (the fixture has no POST /users handler)", async () => {
    const init = await initSession(DATA_PLANE, `Bearer ${bearer.key}`);
    const call = await mcpRequest(
      DATA_PLANE,
      init.sessionId,
      {
        jsonrpc: "2.0",
        method: "tools/call",
        id: 6,
        params: {
          name: `${SERVER_NAME}__create-user`,
          arguments: { name: "Ada", email: "ada@example.com" },
        },
      },
      `Bearer ${bearer.key}`,
    );
    expect(call.status).toBe(200);
    expect(call.isError).toBe(true);
  });
});
