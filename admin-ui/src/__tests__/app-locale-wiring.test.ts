import { describe, expect, it } from "vitest";
import appSrc from "../App.vue?raw";

// Regression test for a real bug: useTheme/useDensity are imported into
// App.vue purely for their module-load-time side effect (applying the saved
// preference to the document before any route renders) — see App.vue's own
// comment. useLocale.ts has the identical "eager apply" pattern (its own doc
// comment even says "follows the same pattern as useTheme.ts"), but was never
// added to App.vue's side-effect imports. Every route except /account (the
// only place that happens to import useLocale.ts directly, for its toggle)
// silently ignored a stored/detected locale preference and rendered in the
// compile-time default (English) on every fresh page load. Source-text
// assertion rather than a full App.vue mount: App.vue pulls in the router,
// auth, and every lazy-loaded page, which makes mounting it in isolation
// heavy and brittle; the invariant that actually matters is just "this
// import line exists," which a plain substring check verifies directly.
describe("App.vue locale wiring", () => {
  it("imports useLocale for its module-load-time side effect, alongside useTheme/useDensity", () => {
    expect(appSrc).toMatch(/import\s+["']\.\/composables\/useLocale["'];/);
  });
});
