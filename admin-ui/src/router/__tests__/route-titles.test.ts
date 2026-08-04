// Every route must be able to name itself in every locale.
//
// resolvePageTitle feeds two things: `document.title` (browser tab, history,
// bookmarks) and `routeAnnouncement`, the text App.vue renders into its polite
// aria-live region after each navigation. Its last-resort branch humanizes the
// route slug, which is not a translation and is barely even English — before the
// create routes carried a `titleKey`, every one of them announced "Bundle new",
// "Key new", "Policy new" to a screen reader on a page rendering Spanish.
//
// So this pins the invariant that no route needs that fallback: each one resolves
// either through an explicit `meta.titleKey`, through the shared `nav.<name>.label`
// the sidebar already uses, or (dynamic routes only) through a route param that
// carries the entity's own name. Both locales are checked, so adding a create page
// with an EN-only title fails here rather than silently shipping.
import { describe, expect, it } from "vitest";
import { router } from "../index";

// Ask the real i18n instance, not the raw JSON: @intlify/unplugin-vue-i18n
// precompiles locale files into message ASTs at build time, so `en.pages.login.title`
// is a compiled node object rather than a string, and a hand-rolled lookup that
// checks `typeof === "string"` reports every key missing. `te()` is the supported
// way to ask "does this key resolve in this locale".
const i18n = (globalThis as unknown as { __testI18n: { global: { te(k: string, l?: string): boolean } } }).__testI18n;

const LOCALES = ["en", "es"] as const;
const has = (key: string, locale: string) => i18n.global.te(key, locale);

describe("route titles", () => {
  // `/` is a bare redirect with no component and never renders a title.
  const routes = router.getRoutes().filter((r) => r.path !== "/");

  it("names every route without falling back to the humanized slug", () => {
    const unnamed: string[] = [];

    for (const route of routes) {
      const name = typeof route.name === "string" ? route.name : "";
      const titleKey = typeof route.meta.titleKey === "string" ? route.meta.titleKey : "";
      // Dynamic routes deliberately title themselves from their param (the server,
      // bundle, composite or trace the page is showing), which beats any static key.
      const isDynamic = route.path.includes(":") && name !== "not-found";

      if (isDynamic) continue;
      for (const locale of LOCALES) {
        const resolved = (titleKey && has(titleKey, locale)) || has(`nav.${name}.label`, locale);
        if (!resolved) unnamed.push(`[${locale}] ${route.path} (name: ${name || "—"})`);
      }
    }

    expect(unnamed).toEqual([]);
  });

  it("points every declared titleKey at a string that exists in both locales", () => {
    const missing: string[] = [];

    for (const route of routes) {
      const titleKey = typeof route.meta.titleKey === "string" ? route.meta.titleKey : "";
      if (!titleKey) continue;
      for (const locale of LOCALES) {
        if (!has(titleKey, locale)) missing.push(`[${locale}] ${titleKey} (${route.path})`);
      }
    }

    expect(missing).toEqual([]);
  });

  it("gives every create route a titleKey, since none has a nav label to fall back on", () => {
    const createRoutes = routes.filter((r) => r.path.endsWith("/new"));
    // Guard against the filter silently matching nothing if the paths ever change.
    expect(createRoutes.length).toBeGreaterThan(10);

    expect(createRoutes.filter((r) => typeof r.meta.titleKey !== "string").map((r) => r.path)).toEqual([]);
  });
});
