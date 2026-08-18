// The Activity page is a tab strip over three routed panels. What it must get
// right is the wiring between the two: the URL decides which tab is selected
// (never local state), operating a tab navigates, and the strip/panel pair is a
// real ARIA tablist rather than three styled links.
//
// The keyboard model itself lives in TabStrip.vue and has its own tests; the case
// below re-checks it through this page because here an arrow key also has to
// produce a NAVIGATION, which is the part a shared component cannot promise.
import { describe, expect, it } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { createRouter, createMemoryHistory, type Router } from "vue-router";
import ActivityPage from "../ActivityPage.vue";
import { navTabsOf } from "@/navigation";

const Panel = { template: "<section class='list-shell'>panel</section>" };

/**
 * The real parent/child shape from navigation.ts, with the three heavy page
 * components swapped for a stub — this exercises tab selection and navigation,
 * not the panels' own data loading.
 */
function makeRouter(): Router {
  const tabs = navTabsOf("activity");
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      {
        path: "/activity",
        component: ActivityPage,
        children: [
          { path: "", redirect: { name: "usage" } },
          ...tabs.map((tab) => ({ path: tab.path.slice("/activity/".length), name: tab.name, component: Panel })),
        ],
      },
    ],
  });
}

/**
 * Mounted through a bare <RouterView>, not as `mount(ActivityPage)`: the page's
 * own <RouterView> resolves against its depth in the matched chain, so mounting
 * the component directly makes the inner view re-render ActivityPage itself and
 * the page comes out with two tab strips.
 */
async function mountAt(path: string) {
  const router = makeRouter();
  await router.push(path);
  await router.isReady();
  const wrapper = mount({ template: "<RouterView />" }, { global: { plugins: [router] } });
  await flushPromises();
  return { wrapper, router };
}

describe("ActivityPage", () => {
  it("renders one tab per navigation entry, in order", async () => {
    const { wrapper } = await mountAt("/activity/usage");

    expect(wrapper.findAll('[role="tab"]').map((t) => t.text())).toEqual(["Usage", "Traffic", "Traces"]);
    expect(wrapper.find('[role="tablist"]').attributes("aria-label")).toBe("Activity views");
  });

  it("takes the selected tab from the URL, so a deep link and a reload agree", async () => {
    const { wrapper } = await mountAt("/activity/traces");

    const selected = wrapper.findAll('[role="tab"]').filter((t) => t.attributes("aria-selected") === "true");
    expect(selected).toHaveLength(1);
    expect(selected[0].text()).toBe("Traces");
  });

  it("navigates when a tab is activated, rather than swapping local state", async () => {
    const { wrapper, router } = await mountAt("/activity/usage");

    await wrapper.findAll('[role="tab"]')[1].trigger("click");
    await flushPromises();

    expect(router.currentRoute.value.path).toBe("/activity/traffic");
    // …and the strip follows the route it just wrote, not a second copy of the
    // selection kept on the side.
    expect(wrapper.findAll('[role="tab"]')[1].attributes("aria-selected")).toBe("true");
  });

  it("moves between tabs with the arrow keys, and each move is a navigation", async () => {
    const { wrapper, router } = await mountAt("/activity/usage");

    await wrapper.findAll('[role="tab"]')[0].trigger("keydown", { key: "ArrowRight" });
    await flushPromises();
    expect(router.currentRoute.value.name).toBe("traffic");

    // Home/End are part of the pattern too, and End proves the wrap-around isn't
    // doing the work by accident.
    await wrapper.findAll('[role="tab"]')[1].trigger("keydown", { key: "End" });
    await flushPromises();
    expect(router.currentRoute.value.name).toBe("traces");
  });

  it("associates the panel with the selected tab, both directions", async () => {
    const { wrapper } = await mountAt("/activity/traffic");

    const panel = wrapper.get('[role="tabpanel"]');
    const trafficTab = wrapper.findAll('[role="tab"]')[1];

    expect(panel.attributes("aria-labelledby")).toBe(trafficTab.attributes("id"));
    expect(trafficTab.attributes("aria-controls")).toBe(panel.attributes("id"));
  });

  it("renders the routed panel inside the tabpanel, and no heading of its own", async () => {
    const { wrapper } = await mountAt("/activity/usage");

    expect(wrapper.get('[role="tabpanel"]').text()).toContain("panel");
    // Each panel page keeps its own <h1>; a second one here would leave the page
    // with two competing top-level headings.
    expect(wrapper.find("h1").exists()).toBe(false);
  });
});
