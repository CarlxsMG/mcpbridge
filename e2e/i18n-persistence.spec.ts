/**
 * End-to-end i18n test — the saved UI language must apply on EVERY route.
 *
 * This re-creates a real P0 this repo shipped. `composables/useLocale.ts`
 * applies the persisted locale as a module-load side effect (same pattern as
 * useTheme/useDensity), but that import was never added to `App.vue` — and
 * `App.vue` is the one component in every route's chunk graph. The only page
 * that imported `useLocale` directly was `AccountPage.vue`, where the language
 * switcher lives, so a stored Spanish preference was honoured on `/account`
 * and silently ignored on every other page load. Unit tests were green and
 * `bun run check` passed; only driving the real browser exposed it.
 * (`admin-ui/src/__tests__/app-locale-wiring.test.ts` now pins the import line;
 * this spec pins the *behaviour* that line is supposed to buy.)
 *
 * How the preference is actually stored — client-side only. `useLocale.ts`
 * writes `localStorage["mcpbridge:locale"]`; the backend has no user-locale
 * column or endpoint (the only `locale` hits in `src/` are `localeCompare`).
 * So the preference follows the *browser*, not the account — asserted
 * explicitly below rather than pretending it is server-side.
 *
 * State isolation: because the preference lives in localStorage, it dies with
 * the Playwright browser context, so no other spec can inherit a Spanish UI
 * from this one (several assert on English strings — `login()` in
 * support/admin.ts asserts the "Servers" heading). This spec still uses its own
 * dedicated account and still switches back to English at the end, so nothing
 * depends on that argument holding.
 */
import { test, expect, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { APP_BASE_URL, BOOTSTRAP_ADMIN_PASSWORD, BOOTSTRAP_ADMIN_USERNAME } from "./support/env";
import { createAdminUser, login, loginAs } from "./support/admin";

/** Dedicated account for this spec (username is lower-cased by the backend). */
const I18N_USERNAME = "e2e-i18n-admin";
const I18N_PASSWORD = "e2e-i18n-strong-pw-2026"; // >= 12 chars (user-create rule)

/** Where useLocale.ts persists the choice — admin-ui/src/i18n.ts LOCALE_STORAGE_KEY. */
const LOCALE_STORAGE_KEY = "mcpbridge:locale";

type Locale = "en" | "es";

/**
 * Routes walked in both languages, with the page `<h1>` each renders.
 * `PageHeader.vue` is the only `<h1>` inside the app shell, so `h1` is an
 * unambiguous, structural handle on "the page heading".
 */
const ROUTE_HEADINGS: ReadonlyArray<{ path: string; en: string; es: string }> = [
  { path: "/admin/servers", en: "Servers", es: "Servidores" },
  { path: "/admin/overview", en: "Overview", es: "Resumen" },
  { path: "/admin/usage", en: "Usage", es: "Uso" },
];

/**
 * `/admin/keys` is asserted on its subtitle, not its heading: `pages.keys.title`
 * is the untranslated "API keys" in BOTH locales, so a heading assertion there
 * would pass whatever the active language is. Strings copied from
 * admin-ui/src/locales/{en,es}.json (`pages.keys.subtitle`).
 */
const KEYS_SUBTITLE: Record<Locale, string> = {
  en: "MCP keys authenticate clients calling the bridge",
  es: "Las keys MCP autentican a los clientes que llaman al bridge",
};

/** `nav.servers.label` — the sidebar entry that must follow the locale too. */
const NAV_SERVERS: Record<Locale, string> = { en: "Servers", es: "Servidores" };

/** `pages.account.preferences` — the `<h2>` above the language switcher. */
const ACCOUNT_PREFERENCES: Record<Locale, string> = { en: "Preferences", es: "Preferencias" };

/**
 * The language switcher's clickable target.
 *
 * `style.css` renders `.segmented input[type="radio"]` at 1x1 with `opacity: 0`
 * and `pointer-events: none`, so the `<label>` wrapping it is what a real user
 * clicks. Selecting via the input's `value` keeps the selector independent of
 * the displayed language — the visible text is the thing under test, so it must
 * never be what we navigate by.
 */
function localeOption(page: Page, code: Locale): Locator {
  return page.locator(`label:has(input[name="locale-pref"][value="${code}"])`);
}

/**
 * Sign in without depending on any UI string. The shared `login()` helper
 * asserts the English "Servers" heading, which is exactly wrong once a context
 * has a Spanish preference stored — so specs in that state use this instead.
 */
async function loginLocaleAgnostic(page: Page, username: string, password: string): Promise<void> {
  await page.goto("/admin/login");
  await page.locator("#username").fill(username);
  await page.locator("#password").fill(password);
  await page.locator("form button[type='submit']").click();
  await expect(page).toHaveURL(/\/admin\/servers$/);
  await expect(page.locator("#sidebar-nav")).toBeVisible();
}

/**
 * The persisted preference, read from the browser context's storage state.
 * `storageState()` rather than `page.evaluate` so the read stays inside
 * Playwright's own types and needs no DOM lib in tsconfig.tools.json.
 */
async function storedLocale(page: Page): Promise<string | null> {
  const state = await page.context().storageState();
  const origin = state.origins.find((o) => o.origin === APP_BASE_URL);
  return origin?.localStorage.find((entry) => entry.name === LOCALE_STORAGE_KEY)?.value ?? null;
}

/**
 * Load each route as a FRESH DOCUMENT (`page.goto`, not an in-app link) and
 * assert the heading is in `locale`. Full page loads are deliberate: the
 * original bug only manifested on a fresh load, because switching on /account
 * had already mutated the in-memory vue-i18n ref, so client-side navigation
 * looked correct even while the app was broken.
 */
async function expectRouteHeadings(page: Page, locale: Locale): Promise<void> {
  for (const route of ROUTE_HEADINGS) {
    await page.goto(route.path);
    await expect(page.locator("h1"), `${route.path} heading should be ${locale}`).toHaveText(route[locale]);
  }
  await page.goto("/admin/keys");
  await expect(page.getByText(KEYS_SUBTITLE[locale])).toBeVisible();
}

/** The sidebar is shared chrome, so it is its own regression surface. */
async function expectSidebar(page: Page, locale: Locale): Promise<void> {
  const sidebar = page.locator("#sidebar-nav");
  const other: Locale = locale === "es" ? "en" : "es";
  await expect(sidebar.getByRole("link", { name: NAV_SERVERS[locale], exact: true })).toBeVisible();
  // Negative control: the other language's label is gone, so this is a real
  // switch and not a half-translated render.
  await expect(sidebar.getByRole("link", { name: NAV_SERVERS[other], exact: true })).toHaveCount(0);
}

test.describe("i18n — a saved language applies on every route, not just /account", () => {
  // Pin the browser's own language so `readInitialLocale()`'s
  // `navigator.language` fallback is deterministic: on a Spanish-locale
  // machine an un-pinned context would boot the SPA in Spanish and every
  // "starts in English" baseline below would be meaningless.
  test.use({ locale: "en-US" });

  test.beforeAll(async ({ browser }) => {
    const context = await browser.newContext({ locale: "en-US" });
    const page = await context.newPage();
    try {
      // Fresh context => empty localStorage => English UI, so the shared
      // `login()` helper's English heading assertion holds here.
      const auth = await loginAs(page, BOOTSTRAP_ADMIN_USERNAME, BOOTSTRAP_ADMIN_PASSWORD);
      await createAdminUser(context.request, auth, {
        username: I18N_USERNAME,
        password: I18N_PASSWORD,
        role: "admin",
      });
    } finally {
      await context.close();
    }
  });

  test("switching to Spanish on /account applies everywhere, survives a reload, and reverts", async ({ page }) => {
    // ~14 full document loads; the 30s file default is uncomfortably tight.
    test.setTimeout(90_000);

    await login(page, I18N_USERNAME, I18N_PASSWORD);

    // ── (a) Baseline: English, nothing persisted yet ──────────────────────────
    await page.goto("/admin/account");
    await expect(page.locator("h1")).toHaveText("Account");
    await expect(page.getByRole("heading", { name: ACCOUNT_PREFERENCES.en })).toBeVisible();
    expect(await storedLocale(page)).toBeNull();

    // ── (b) Switch to Spanish through the real switcher ───────────────────────
    await localeOption(page, "es").click();
    await expect(page.locator("h1")).toHaveText("Cuenta");
    await expect(page.getByRole("heading", { name: ACCOUNT_PREFERENCES.es })).toBeVisible();
    // The <html lang> flip is asserted here, in the SAME document: index.html
    // ships `<html lang="en">`, so seeing "es" without a reload proves the app
    // wrote it. (Asserting lang="en" right after a page load would be vacuous.)
    await expect(page.locator("html")).toHaveAttribute("lang", "es");
    expect(await storedLocale(page)).toBe("es");
    await expectSidebar(page, "es");

    // ── (c) THE HEADLINE: every OTHER route is Spanish too ────────────────────
    // This is precisely what the original bug got wrong — the preference
    // applied on /account and nowhere else.
    await expectRouteHeadings(page, "es");
    await expectSidebar(page, "es");
    // Served markup says lang="en"; the app must overwrite it on a cold load of
    // a route that never touches AccountPage.
    await expect(page.locator("html")).toHaveAttribute("lang", "es");

    // ── (d) A hard reload on a NON-account route stays Spanish ────────────────
    // Proves it re-hydrates from the persisted preference rather than from
    // in-memory state left behind by the switcher.
    await page.goto("/admin/usage");
    await page.reload();
    await expect(page.locator("h1")).toHaveText("Uso");
    await expect(page.locator("html")).toHaveAttribute("lang", "es");

    // ── (e) Switch back to English — a one-way-only bug is just as real ───────
    await page.goto("/admin/account");
    await expect(page.locator("h1")).toHaveText("Cuenta");
    await localeOption(page, "en").click();
    await expect(page.locator("h1")).toHaveText("Account");
    // Live flip back within the same document, so this one is not vacuous.
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    expect(await storedLocale(page)).toBe("en");

    await expectRouteHeadings(page, "en");
    await expectSidebar(page, "en");
  });

  test("a stored preference is applied on a deep-linked route that never renders /account", async ({ browser }) => {
    // The tightest form of the regression: seed the persisted preference
    // directly, then land on a non-account route. Nothing in this test ever
    // visits /account, so only App.vue's eager `useLocale` import can apply it.
    const context = await browser.newContext({ locale: "en-US" });
    // A string body rather than a function so the init script needs no DOM
    // typings in the spec itself.
    await context.addInitScript({ content: `localStorage.setItem("${LOCALE_STORAGE_KEY}", "es");` });
    const page = await context.newPage();
    try {
      await loginLocaleAgnostic(page, I18N_USERNAME, I18N_PASSWORD);

      await page.goto("/admin/usage");
      await expect(page.locator("h1")).toHaveText("Uso");
      await expect(page.locator("html")).toHaveAttribute("lang", "es");
      await expectSidebar(page, "es");

      await page.goto("/admin/overview");
      await expect(page.locator("h1")).toHaveText("Resumen");
      await expect(page.locator("html")).toHaveAttribute("lang", "es");
    } finally {
      await context.close();
    }
  });

  test("the preference is per-browser (localStorage), not attached to the account", async ({ browser }) => {
    // Asserting the design the code actually implements. useLocale.ts stores the
    // choice in localStorage and the backend has no user-locale field, so a
    // second browser signing into the SAME account correctly starts from the
    // default. If a server-side preference is ever added, THIS is the test that
    // should start failing and be rewritten to demand Spanish here.
    const first = await browser.newContext({ locale: "en-US" });
    let second: BrowserContext | null = null;
    try {
      const firstPage = await first.newPage();
      await login(firstPage, I18N_USERNAME, I18N_PASSWORD);
      await firstPage.goto("/admin/account");
      await localeOption(firstPage, "es").click();
      await expect(firstPage.locator("h1")).toHaveText("Cuenta");
      expect(await storedLocale(firstPage)).toBe("es");

      second = await browser.newContext({ locale: "en-US" });
      const secondPage = await second.newPage();
      // Locale-agnostic on purpose: the whole point is that we do not yet know
      // which language this context will render in.
      await loginLocaleAgnostic(secondPage, I18N_USERNAME, I18N_PASSWORD);
      expect(await storedLocale(secondPage)).toBeNull();
      await expect(secondPage.locator("h1")).toHaveText("Servers");
      await expectSidebar(secondPage, "en");

      // …and the first browser is untouched by the second one's session.
      await firstPage.goto("/admin/servers");
      await expect(firstPage.locator("h1")).toHaveText("Servidores");
    } finally {
      await first.close();
      await second?.close();
    }
  });
});
