// The nav tier split is a SIDEBAR concern only. These cases pin the two halves
// of that promise: the day-1 set is exactly what we think it is (so nobody
// enlarges it by accident), and hiding a page from the sidebar never removes it
// from the router or from the command palette — the power-user escape hatch that
// makes progressive disclosure safe in the first place.
import { describe, expect, it, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { createRouter, createMemoryHistory } from "vue-router";
import { navEntries, navEntryNameForPath } from "../navigation";
import CommandPalette from "@/components/CommandPalette.vue";
import { router as appRouter } from "@/router";

vi.mock("@/composables/useAuth", () => ({
  useAuth: () => ({ state: { user: { username: "root", role: "admin" } } }),
}));

vi.mock("@/composables/useApi", () => ({
  api: { get: vi.fn().mockResolvedValue({ items: [] }) },
}));

const CORE = ["servers", "bundles", "keys", "overview", "activity", "audit-log", "users", "config", "account"];

describe("nav tiers", () => {
  it("keeps the day-1 set to the pages a fresh instance actually needs", () => {
    expect(navEntries.filter((e) => e.tier === "core").map((e) => e.name)).toEqual(CORE);
  });

  it("still routes to every advanced page", () => {
    // The router builds its static routes from this same list, tier-blind.
    const routed = new Set(appRouter.getRoutes().map((r) => r.path));
    for (const entry of navEntries.filter((e) => e.tier === "advanced")) {
      expect(routed.has(entry.path)).toBe(true);
    }
  });

  it("resolves a path to its owning entry by longest prefix", () => {
    expect(navEntryNameForPath("/servers")).toBe("servers");
    expect(navEntryNameForPath("/servers/payments/tools/list")).toBe("servers");
    expect(navEntryNameForPath("/schedules/new")).toBe("schedules");
    expect(navEntryNameForPath("/login")).toBeNull();
    // Not a prefix match on the string: /servers must not claim /servers-foo.
    expect(navEntryNameForPath("/servers-foo")).toBeNull();
  });

  it("answers a tab's path with the entry the sidebar actually renders", () => {
    // /activity/traffic is a tab of the Activity page, and the Activity row is
    // the only one in the sidebar. Answering "traffic" — an entry with no row —
    // would leave the open page unrepresented in the nav, which is the exact
    // disorientation the longest-prefix lookup exists to prevent.
    expect(navEntryNameForPath("/activity")).toBe("activity");
    expect(navEntryNameForPath("/activity/usage")).toBe("activity");
    expect(navEntryNameForPath("/activity/traffic")).toBe("activity");
    expect(navEntryNameForPath("/activity/traces")).toBe("activity");
  });
});

describe("command palette", () => {
  it("indexes advanced pages the sidebar hides by default", async () => {
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: "/:pathMatch(.*)*", component: { template: "<div />" } }],
    });
    await router.push("/servers");
    await router.isReady();

    const wrapper = mount(CommandPalette, { global: { plugins: [router] } });
    await wrapper.get(".cmd-trigger").trigger("click");
    await flushPromises();

    await wrapper.get("input[role=combobox]").setValue("schedules");
    expect(wrapper.findAll(".cmd-item-label").map((n) => n.text())).toContain("Schedules");
  });

  it("still reaches a page that became a tab, by the tab's own name", async () => {
    // Folding Usage/Traffic/Traces into the Activity page removed three sidebar
    // rows on purpose. It must NOT also remove the three names: someone who
    // knows they want traces types "traces", not "activity".
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: "/:pathMatch(.*)*", component: { template: "<div />" } }],
    });
    await router.push("/servers");
    await router.isReady();

    const wrapper = mount(CommandPalette, { global: { plugins: [router] } });
    await wrapper.get(".cmd-trigger").trigger("click");
    await flushPromises();

    await wrapper.get("input[role=combobox]").setValue("traces");
    const hit = wrapper.findAll(".cmd-item").find((item) => item.text().includes("Traces"));
    expect(hit).toBeDefined();
    // …and it points at the tab, not at the retired top-level URL.
    expect(appRouter.resolve(navEntries.find((e) => e.name === "traces")?.path ?? "").name).toBe("traces");
  });
});
