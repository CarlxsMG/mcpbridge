/**
 * Admin-UI and admin-API driving helpers shared by the e2e specs.
 *
 * Two families live here:
 *   - UI drivers (`login`, `logout`, `registerFixtureServer`) that go through
 *     the real SPA, for specs whose subject IS the SPA.
 *   - API helpers (`mintMcpKey`, `createTeam`, `registerViaApi`, ...) for specs
 *     that need a backend in a given state but aren't testing how it got there.
 *     Driving the register form through the browser costs a page load and three
 *     network round trips per server; most specs need several servers.
 *
 * Everything is idempotent where the backend allows it: playwright.config.ts
 * sets `reuseExistingServer` outside CI, so a local re-run meets the database
 * the previous run left behind and a bare 201-only assertion would fail on the
 * second invocation.
 */
import { expect, type APIRequestContext, type Page } from "@playwright/test";
import {
  APP_BASE_URL,
  BOOTSTRAP_ADMIN_PASSWORD,
  BOOTSTRAP_ADMIN_USERNAME,
  FIXTURE_BASE_URL,
  FIXTURE_CONTROL_PATH,
  FIXTURE_GRAPHQL_PATH,
  FIXTURE_OPENAPI_PATH,
} from "./env";

/** The session + CSRF pair a spec needs to call the admin API as a logged-in user. */
export interface AdminAuth {
  cookie: string;
  csrf: string;
}

/** An admin role as accepted by POST /admin-api/users (src/security/user-store.ts). */
export type AdminRole = "admin" | "operator" | "auditor" | "viewer";

/**
 * Log in through the real login form. Defaults to the bootstrap admin; pass
 * credentials explicitly to sign in as another account (rbac-viewer does).
 * Resolves once the post-login dashboard heading is visible.
 */
export async function login(
  page: Page,
  username: string = BOOTSTRAP_ADMIN_USERNAME,
  password: string = BOOTSTRAP_ADMIN_PASSWORD,
): Promise<void> {
  await page.goto("/admin/login");
  await page.locator("#username").fill(username);
  await page.locator("#password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Servers" })).toBeVisible();
}

/**
 * Pull the session + CSRF pair out of the browser context so a spec can call
 * the admin API directly with the same identity it logged in as.
 *
 * The CSRF cookie is non-httpOnly by design (admin-ui/src/utils/cookies.ts
 * reads it from JS), which is why the matching X-CSRF-Token value is
 * available here at all.
 */
export async function adminAuthHeaders(page: Page): Promise<AdminAuth> {
  const cookies = await page.context().cookies();
  const sid = cookies.find((c) => c.name === "mcp_admin_session")?.value;
  if (!sid) throw new Error("admin session cookie not set — login step failed?");
  const csrf = cookies.find((c) => c.name === "mcp_admin_csrf" || c.name === "__Host-mcp_admin_csrf")?.value;
  if (!csrf) throw new Error("admin CSRF cookie not set — login step failed?");
  return { cookie: `mcp_admin_session=${sid}`, csrf };
}

/** Log in in one step and hand back both the page and its API credentials. */
export async function loginAs(page: Page, username?: string, password?: string): Promise<AdminAuth> {
  await login(page, username, password);
  return adminAuthHeaders(page);
}

/** Header bag for a session-authenticated, CSRF-protected admin API call. */
export function apiHeaders(auth: AdminAuth, extra: Record<string, string> = {}): Record<string, string> {
  return {
    cookie: auth.cookie,
    "x-csrf-token": auth.csrf,
    "content-type": "application/json",
    ...extra,
  };
}

/** Sign out through the UI and wait for the login form to come back. */
export async function logout(page: Page): Promise<void> {
  await page.goto("/admin/account");
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/admin\/login$/);
}

// ── Server registration ─────────────────────────────────────────────────────

/**
 * Register a REST backend from the OpenAPI fixture by driving the real
 * register-server form. Several specs depend on that discovery path actually
 * working end to end, which is why this stays a UI driver — use
 * `registerViaApi` when a spec only needs the server to exist.
 */
export async function registerFixtureServer(
  page: Page,
  serverName: string,
  openapiPath: string = FIXTURE_OPENAPI_PATH,
): Promise<void> {
  await page.locator("#sidebar-nav").getByRole("link", { name: "Add server" }).click();
  await expect(page).toHaveURL(/\/admin\/register-server$/);
  await page.locator("#r-name").fill(serverName);
  await page.locator("#r-health").fill(`${FIXTURE_BASE_URL}/health`);
  await page.locator("#r-openapi").fill(`${FIXTURE_BASE_URL}${openapiPath}`);
  await page.getByRole("button", { name: "Preview tools" }).click();
  await expect(page.getByText(/tool\(s\) discovered/)).toBeVisible();
  await page.getByRole("button", { name: "Register server" }).click();
  await expect(page).toHaveURL(new RegExp(`/admin/servers/${serverName}$`));
}

/**
 * Register the fixture as a REST backend straight through POST /register.
 *
 * Tolerates the 409 a re-run against a reused server produces. Returns whether
 * this call was the one that created it, for specs that care.
 */
export async function registerViaApi(
  request: APIRequestContext,
  auth: AdminAuth,
  serverName: string,
  openapiPath: string = FIXTURE_OPENAPI_PATH,
): Promise<{ created: boolean }> {
  const res = await request.post(`${APP_BASE_URL}/register`, {
    headers: apiHeaders(auth),
    data: {
      name: serverName,
      health_url: `${FIXTURE_BASE_URL}/health`,
      base_url: FIXTURE_BASE_URL,
      openapi_url: `${FIXTURE_BASE_URL}${openapiPath}`,
    },
  });
  expect([200, 201, 409], `register(${serverName}) failed: ${res.status()} ${await res.text()}`).toContain(
    res.status(),
  );
  return { created: res.status() !== 409 };
}

/** Register the fixture's GraphQL endpoint as a `kind: "graphql"` client. */
export async function registerGraphqlViaApi(
  request: APIRequestContext,
  auth: AdminAuth,
  serverName: string,
): Promise<{ created: boolean }> {
  const res = await request.post(`${APP_BASE_URL}/register`, {
    headers: apiHeaders(auth),
    data: {
      name: serverName,
      kind: "graphql",
      health_url: `${FIXTURE_BASE_URL}/health`,
      base_url: FIXTURE_BASE_URL,
      graphql_url: `${FIXTURE_BASE_URL}${FIXTURE_GRAPHQL_PATH}`,
    },
  });
  expect([200, 201, 409], `register graphql(${serverName}) failed: ${res.status()} ${await res.text()}`).toContain(
    res.status(),
  );
  return { created: res.status() !== 409 };
}

/**
 * Register an MCP upstream. The e2e stack points this at the bridge's own data
 * plane (`/mcp/:client`) so the gateway proxies to itself — a real MCP upstream
 * without a second server to run.
 */
export async function registerMcpUpstreamViaApi(
  request: APIRequestContext,
  auth: AdminAuth,
  serverName: string,
  mcpUrl: string,
  authHeader?: string,
): Promise<{ created: boolean; status: number; body: string }> {
  const res = await request.post(`${APP_BASE_URL}/register`, {
    headers: apiHeaders(auth),
    data: {
      name: serverName,
      kind: "mcp",
      mcp_url: mcpUrl,
      health_url: `${FIXTURE_BASE_URL}/health`,
      ...(authHeader ? { auth: { type: "bearer", token: authHeader.replace(/^Bearer /, "") } } : {}),
    },
  });
  return { created: res.status() !== 409, status: res.status(), body: await res.text() };
}

/** Delete a registered client, ignoring "it was never there". */
export async function deleteClient(request: APIRequestContext, auth: AdminAuth, serverName: string): Promise<void> {
  const res = await request.delete(`${APP_BASE_URL}/admin-api/clients/${serverName}`, {
    headers: apiHeaders(auth),
  });
  expect([200, 204, 404], `delete client failed: ${res.status()}`).toContain(res.status());
}

// ── Managed MCP keys ────────────────────────────────────────────────────────

/** Options mirroring the POST /admin-api/mcp-keys body beyond the label. */
export interface MintKeyOptions {
  scopes?: string[] | null;
  expiresAt?: string | null;
  consumerId?: number | null;
  elevated?: boolean;
  adminRole?: string | null;
}

/**
 * Mint a managed MCP key. Was copy-pasted in three specs before this existed.
 *
 * Note the side effect: the FIRST key to exist flips the data plane out of
 * "open mode" into fail-closed for the whole process — see
 * auth-fail-closed.spec.ts, which asserts on exactly that transition and is
 * therefore order-sensitive with respect to every caller of this function.
 */
export async function mintMcpKey(
  request: APIRequestContext,
  auth: AdminAuth,
  label: string,
  options: MintKeyOptions = {},
): Promise<{ id: number; key: string; authHeader: string }> {
  const res = await request.post(`${APP_BASE_URL}/admin-api/mcp-keys`, {
    headers: apiHeaders(auth),
    data: {
      label,
      scopes: options.scopes ?? null,
      expiresAt: options.expiresAt ?? null,
      consumerId: options.consumerId ?? null,
      elevated: options.elevated ?? false,
      adminRole: options.adminRole ?? null,
    },
  });
  expect(res.status(), `mcp-key create failed: ${await res.text()}`).toBe(201);
  const body = (await res.json()) as { id: number; key: string };
  return { ...body, authHeader: `Bearer ${body.key}` };
}

/** Revoke a managed MCP key by id. */
export async function revokeMcpKey(request: APIRequestContext, auth: AdminAuth, id: number): Promise<void> {
  const res = await request.post(`${APP_BASE_URL}/admin-api/mcp-keys/${id}/revoke`, {
    headers: apiHeaders(auth),
  });
  expect(res.status(), `revoke failed: ${await res.text()}`).toBe(200);
}

// ── Users and teams ─────────────────────────────────────────────────────────

/**
 * Create an admin user, tolerating the 409 from a re-run. Passwords must be at
 * least 12 characters (the user-create rule).
 */
export async function createAdminUser(
  request: APIRequestContext,
  auth: AdminAuth,
  user: { username: string; password: string; role: AdminRole },
): Promise<void> {
  const res = await request.post(`${APP_BASE_URL}/admin-api/users`, {
    headers: apiHeaders(auth),
    data: user,
  });
  expect([201, 409], `user create(${user.username}) failed: ${res.status()} ${await res.text()}`).toContain(
    res.status(),
  );
}

/**
 * Create a team and return its id. On the 409 from a re-run, looks the existing
 * team up by name so the caller still gets a usable id.
 */
export async function createTeam(request: APIRequestContext, auth: AdminAuth, name: string): Promise<number> {
  const res = await request.post(`${APP_BASE_URL}/admin-api/teams`, {
    headers: apiHeaders(auth),
    data: { name },
  });
  if (res.status() === 201) {
    return ((await res.json()) as { id: number }).id;
  }
  expect([409], `team create(${name}) failed: ${res.status()} ${await res.text()}`).toContain(res.status());

  const list = await request.get(`${APP_BASE_URL}/admin-api/teams`, { headers: apiHeaders(auth) });
  expect(list.status()).toBe(200);
  const items = ((await list.json()) as { items: { id: number; name: string }[] }).items;
  const found = items.find((t) => t.name === name);
  if (!found) throw new Error(`team ${name} reported as existing but is not in the list`);
  return found.id;
}

/** Assign (or clear, with null) a user's team. Requires a super-admin caller. */
export async function setUserTeam(
  request: APIRequestContext,
  auth: AdminAuth,
  username: string,
  teamId: number | null,
): Promise<void> {
  const res = await request.put(`${APP_BASE_URL}/admin-api/users/${username}/team`, {
    headers: apiHeaders(auth),
    data: { teamId },
  });
  expect(res.status(), `set user team failed: ${await res.text()}`).toBe(200);
}

/** Assign (or clear, with null) a client's owning team. Requires a super-admin caller. */
export async function setClientTeam(
  request: APIRequestContext,
  auth: AdminAuth,
  clientName: string,
  teamId: number | null,
): Promise<void> {
  const res = await request.put(`${APP_BASE_URL}/admin-api/clients/${clientName}/team`, {
    headers: apiHeaders(auth),
    data: { teamId },
  });
  expect(res.status(), `set client team failed: ${await res.text()}`).toBe(200);
}

// ── Fixture control channel ─────────────────────────────────────────────────

/**
 * Drive the fixture upstream's control channel (support/fixture-server.ts).
 * `down`/`up` toggle only `/api/v1/flaky`; `/health` stays 200 throughout so
 * the bridge's health loop doesn't evict the client mid-spec.
 */
export async function fixtureControl(request: APIRequestContext, action: "down" | "up"): Promise<void> {
  const res = await request.post(`${FIXTURE_BASE_URL}${FIXTURE_CONTROL_PATH}/${action}`);
  expect(res.status(), `fixture control ${action} failed`).toBe(200);
}

/** Read the fixture's current flag plus its per-path hit counts. */
export async function fixtureState(
  request: APIRequestContext,
): Promise<{ flakyDown: boolean; hits: Record<string, number> }> {
  const res = await request.get(`${FIXTURE_BASE_URL}${FIXTURE_CONTROL_PATH}/state`);
  expect(res.status()).toBe(200);
  return (await res.json()) as { flakyDown: boolean; hits: Record<string, number> };
}
