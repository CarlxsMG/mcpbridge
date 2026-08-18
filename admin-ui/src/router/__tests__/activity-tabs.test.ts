// The Activity page's tabs are ROUTES, and this pins what that has to buy: every
// tab is a URL of its own, the URLs those tabs replaced still resolve, a deep link
// keeps its filters, the trace drill-down still has a list to come back to, and a
// tab switch is treated as staying on the same page.
//
// These navigate the REAL app router (not a stand-in built from navEntries), so
// they also cover staticRoute()'s parent/child construction — a tab route that
// forgot its parent would still resolve, but would render without the tab strip.
import { describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { RouterLink } from "vue-router";
import { router, routeAnnouncement } from "../index";

// The router's own beforeEach resolves the session before it lets a navigation
// through; without this every push below would land on /login.
vi.mock("@/composables/useAuth", () => ({
  useAuth: () => ({
    state: { checked: true, user: { username: "root", role: "admin" } },
    checkSession: vi.fn(),
  }),
}));

describe("activity tabs", () => {
  it("gives each tab a URL of its own under the parent page", async () => {
    for (const name of ["usage", "traffic", "traces"]) {
      const resolved = router.resolve({ name });
      expect(resolved.path).toBe(`/activity/${name}`);
      // The parent record must be in the matched chain, or the panel renders
      // without the tab strip that is the whole point of the merge.
      expect(resolved.matched.map((r) => r.path)).toContain("/activity");
    }
  });

  it("lands the parent path on the first tab rather than an empty shell", async () => {
    await router.push("/activity");
    expect(router.currentRoute.value.path).toBe("/activity/usage");
    expect(router.currentRoute.value.name).toBe("usage");
  });

  it("keeps the URLs the tabs replaced working", async () => {
    for (const [legacy, tab] of [
      ["/usage", "/activity/usage"],
      ["/traffic", "/activity/traffic"],
      ["/traces", "/activity/traces"],
    ]) {
      await router.push(legacy);
      expect(router.currentRoute.value.path, `${legacy} should redirect to ${tab}`).toBe(tab);
    }
  });

  it("carries a legacy deep link's filters across the redirect", async () => {
    // A record redirect keeps the query; a guard-based one would not. Dropping it
    // would silently show an unfiltered first page — the kind of "it still works"
    // that is worse than a 404, because nothing looks wrong.
    await router.push("/traffic?client=payments&errors=true&cursor=abc");

    expect(router.currentRoute.value.path).toBe("/activity/traffic");
    expect(router.currentRoute.value.query).toEqual({ client: "payments", errors: "true", cursor: "abc" });
  });

  it("leaves the trace detail route at its own URL, with the list one hop back", async () => {
    await router.push("/traces/abc123");

    expect(router.currentRoute.value.name).toBe("trace-detail");
    expect(router.currentRoute.value.params.traceId).toBe("abc123");
    // TraceDetailPage's back-link target: it must resolve to the Traces TAB now,
    // not to a route that no longer exists.
    expect(router.resolve({ name: "traces" }).path).toBe("/activity/traces");
  });

  it("marks the sidebar's parent link active while a tab is open", async () => {
    // TheSidebar links to the entry's path, /activity, and relies on vue-router
    // treating a link to a parent's empty-path child as active for any of that
    // parent's children. Worth a real assertion rather than a reading of the
    // spec: if it stopped holding, the nav would show nothing highlighted on all
    // three tabs, which is the disorientation the whole nav design avoids.
    await router.push("/activity/traces");
    const link = mount(RouterLink, { props: { to: "/activity" }, global: { plugins: [router] } });

    expect(link.get("a").classes()).toContain("router-link-active");
  });

  it("treats a tab switch as staying on the same page, so focus is left alone", async () => {
    // afterEach moves focus to #main-content and re-announces on a page change.
    // Doing that on a tab switch takes focus off the tab the user just operated,
    // and the tablist's arrow keys die with it: the next arrow key is delivered to
    // <main>, not to a tab. The announcement ref is the observable half of that
    // decision — it must NOT change between two tabs, but must change when the
    // user arrives from somewhere else.
    await router.push("/servers");
    await router.push("/activity/usage");
    expect(routeAnnouncement.value).toBe("Usage");

    await router.push("/activity/traffic");
    expect(routeAnnouncement.value).toBe("Usage");
    // The document title still follows the tab — that is the linkable identity.
    expect(document.title).toBe("Traffic — MCP Bridge");
  });

  it("titles a tab with its own nav label, not the parent's", async () => {
    // The parent record must NOT carry a titleKey: meta is merged down the
    // matched chain, so one there would win over every tab's own label and the
    // browser tab would read "Activity" on all three.
    await router.push("/activity/traces");
    expect(router.currentRoute.value.meta.titleKey).toBeUndefined();
    expect(document.title).toBe("Traces — MCP Bridge");
  });
});
