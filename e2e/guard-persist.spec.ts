/**
 * End-to-end test for the tool-guard edit → save → reload → persisted flow —
 * one of the two flows that only manual verification used to catch (finding
 * #39). The guard editor lives in a drawer on the server-detail page
 * (admin-ui ServerDetailPage.vue → GuardEditor.vue), reached at
 * `/admin/servers/:name/tools/:tool`; saving PATCHes
 * `/admin-api/clients/:name/tools/:tool` with `{ guards: { rateLimitPerMin } }`.
 *
 * What this proves that the unit/route tests don't: the value the operator
 * types survives a full round trip through the SPA — form → PATCH → DB → a
 * fresh page load re-hydrating the field from GET /clients/:name detail. A
 * regression that dropped the guard on write, or failed to re-read it on load,
 * would leave the reloaded field blank and fail here.
 */
import { test, expect } from "@playwright/test";
import { login, registerFixtureServer } from "./support/admin";

/** Unique server name per spec run so this file can run alongside the other specs. */
const SERVER_NAME = "e2e-guard-persist-api";
/** The tool discovered from fixtures/simple-openapi.json (served by global-setup.ts). */
const TOOL_NAME = "list-users";
/** The rate limit we type, save, and expect to read back after a reload. */
const RATE_LIMIT = "42";

test("edit a tool's rate-limit guard, save, reload -> the value persisted", async ({ page }) => {
  await login(page);
  await registerFixtureServer(page, SERVER_NAME);

  // Open the guard-editor drawer for the discovered tool. The trigger carries a
  // stable data attribute (data-guard-trigger) so we don't depend on the
  // "Add guards"/"Edit guards" label wording.
  await page.locator(`[data-guard-trigger="${TOOL_NAME}"]`).click();
  await expect(page).toHaveURL(new RegExp(`/admin/servers/${SERVER_NAME}/tools/${TOOL_NAME}$`));

  const rateLimit = page.locator("#rate-limit");
  await expect(rateLimit).toBeVisible();
  await rateLimit.fill(RATE_LIMIT);

  // Save, and wait for the PATCH to the tool's guards to actually complete
  // (rather than racing the reload below against an in-flight request).
  const toolPatch = new RegExp(`/admin-api/clients/[^/]+/tools/${TOOL_NAME}$`);
  const [patchRes] = await Promise.all([
    page.waitForResponse((r) => r.request().method() === "PATCH" && toolPatch.test(r.url())),
    page.getByRole("button", { name: "Save guards" }).click(),
  ]);
  expect(patchRes.status(), `guard save failed: ${await patchRes.text()}`).toBe(200);

  // Full page reload — the field must re-hydrate from the persisted value, not
  // from any in-memory form state.
  await page.reload();

  const rateLimitAfter = page.locator("#rate-limit");
  await expect(rateLimitAfter).toBeVisible();
  await expect(rateLimitAfter).toHaveValue(RATE_LIMIT);
});
