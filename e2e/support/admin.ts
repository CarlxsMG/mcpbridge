/**
 * Admin-UI driving helpers shared by the e2e specs.
 *
 * `login`, `adminAuthHeaders` and `registerFixtureServer` were previously
 * copy-pasted across specs — byte-identical apart from one extra comment and
 * one spec parameterising `login` for a non-bootstrap account. Each spec still
 * calls them explicitly; nothing here installs a fixture or a hook.
 */
import { expect, type Page } from "@playwright/test";
import { BOOTSTRAP_ADMIN_PASSWORD, BOOTSTRAP_ADMIN_USERNAME, FIXTURE_BASE_URL } from "./env";

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
export async function adminAuthHeaders(page: Page): Promise<{ cookie: string; csrf: string }> {
  const cookies = await page.context().cookies();
  const sid = cookies.find((c) => c.name === "mcp_admin_session")?.value;
  if (!sid) throw new Error("admin session cookie not set — login step failed?");
  const csrf = cookies.find((c) => c.name === "mcp_admin_csrf" || c.name === "__Host-mcp_admin_csrf")?.value;
  if (!csrf) throw new Error("admin CSRF cookie not set — login step failed?");
  return { cookie: `mcp_admin_session=${sid}`, csrf };
}

/**
 * Register a REST backend from the OpenAPI fixture served by global-setup, so
 * the data plane has at least one discovered tool. Drives the real
 * register-server form rather than the admin API — several specs depend on
 * that discovery path actually working.
 */
export async function registerFixtureServer(page: Page, serverName: string): Promise<void> {
  await page.locator("#sidebar-nav").getByRole("link", { name: "Add server" }).click();
  await expect(page).toHaveURL(/\/admin\/register-server$/);
  await page.locator("#r-name").fill(serverName);
  await page.locator("#r-health").fill(`${FIXTURE_BASE_URL}/health`);
  await page.locator("#r-openapi").fill(`${FIXTURE_BASE_URL}/openapi.json`);
  await page.getByRole("button", { name: "Preview tools" }).click();
  await expect(page.getByText(/tool\(s\) discovered/)).toBeVisible();
  await page.getByRole("button", { name: "Register server" }).click();
  await expect(page).toHaveURL(new RegExp(`/admin/servers/${serverName}$`));
}
