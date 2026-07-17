/**
 * End-to-end RBAC test — the second flow only manual verification used to catch
 * (finding #39): a non-admin (viewer) user must not be offered admin-only
 * mutating surfaces in the UI.
 *
 * The admin UI gates its admin-only areas (Users, Teams, Config, SSO) by
 * filtering the sidebar nav on the caller's role (admin-ui useNavEntries.ts +
 * navigation.ts `meta.role: "admin"`) — the backend independently 403s these,
 * but a viewer shouldn't even see the door. The "Users" entry is the canonical
 * one: it links to the admin-user management page (account create/edit/delete),
 * a purely privileged surface.
 *
 * This spec logs in as the bootstrap super-admin (who sees it), provisions a
 * viewer via the admin API, then logs in as that viewer in a fresh browser
 * context and asserts the "Users" management link is absent while an ordinary
 * viewer-visible entry ("Servers") is still present — so the absence is real
 * RBAC filtering, not an unrendered sidebar.
 */
import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { APP_BASE_URL, BOOTSTRAP_ADMIN_PASSWORD, BOOTSTRAP_ADMIN_USERNAME } from "./env";

/** Unique viewer account for this spec (username is lower-cased by the backend). */
const VIEWER_USERNAME = "e2e-rbac-viewer";
const VIEWER_PASSWORD = "e2e-rbac-viewer-strong-pw-2026"; // >= 12 chars (user-create rule)

/** Pulls the admin session + CSRF cookies out of Playwright's storage state. */
async function adminAuthHeaders(page: Page): Promise<{ cookie: string; csrf: string }> {
  const cookies = await page.context().cookies();
  const sid = cookies.find((c) => c.name === "mcp_admin_session")?.value;
  if (!sid) throw new Error("admin session cookie not set — login step failed?");
  const csrf = cookies.find((c) => c.name === "mcp_admin_csrf" || c.name === "__Host-mcp_admin_csrf")?.value;
  if (!csrf) throw new Error("admin CSRF cookie not set — login step failed?");
  return { cookie: `mcp_admin_session=${sid}`, csrf };
}

/** Logs in via the UI with the given credentials; resolves once the Servers heading shows. */
async function login(page: Page, username: string, password: string): Promise<void> {
  await page.goto("/admin/login");
  await page.locator("#username").fill(username);
  await page.locator("#password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Servers" })).toBeVisible();
}

/** Creates the viewer account via the admin API. Tolerates a prior run's leftover (409). */
async function ensureViewer(request: APIRequestContext, cookie: string, csrf: string): Promise<void> {
  const res = await request.post(`${APP_BASE_URL}/admin-api/users`, {
    headers: { cookie, "x-csrf-token": csrf, "content-type": "application/json" },
    data: { username: VIEWER_USERNAME, password: VIEWER_PASSWORD, role: "viewer" },
  });
  // 201 = created now; 409 = already created by an earlier run against a reused
  // dev server (playwright.config.ts reuseExistingServer). Both are fine.
  expect([201, 409], `viewer create failed: ${res.status()} ${await res.text()}`).toContain(res.status());
}

test.describe("RBAC — a viewer is not offered admin-only mutating surfaces", () => {
  // Provision the viewer once, up front, so the two tests below are independent
  // of each other's execution order.
  test.beforeAll(async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await login(page, BOOTSTRAP_ADMIN_USERNAME, BOOTSTRAP_ADMIN_PASSWORD);
      const { cookie, csrf } = await adminAuthHeaders(page);
      await ensureViewer(page.context().request, cookie, csrf);
    } finally {
      await context.close();
    }
  });

  test("the super-admin sidebar shows the admin-only Users management link", async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await login(page, BOOTSTRAP_ADMIN_USERNAME, BOOTSTRAP_ADMIN_PASSWORD);
      // Positive control: the admin DOES see the admin-only Users entry.
      await expect(page.locator("#sidebar-nav").getByRole("link", { name: "Users", exact: true })).toBeVisible();
    } finally {
      await context.close();
    }
  });

  test("a viewer does not see the admin-only Users link (but is logged in)", async ({ browser }) => {
    // A fresh, isolated context so the viewer session doesn't inherit the
    // admin's cookies from the test above.
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await login(page, VIEWER_USERNAME, VIEWER_PASSWORD);

      const sidebar = page.locator("#sidebar-nav");
      // The viewer IS authenticated and the sidebar rendered — an ordinary,
      // non-admin-gated entry is present…
      await expect(sidebar.getByRole("link", { name: "Servers", exact: true })).toBeVisible();
      // …but the admin-only Users management link is filtered out.
      await expect(sidebar.getByRole("link", { name: "Users", exact: true })).toHaveCount(0);
    } finally {
      await context.close();
    }
  });
});
