import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import DonutWidget from "../DonutWidget.vue";
import { emptyStores, type DashboardStores, type WidgetInstance } from "../widgetCatalog";

function storesWith(over: Partial<DashboardStores["overview"]> & object): DashboardStores {
  const s = emptyStores();
  s.overview = {
    clients: { live: 4, disabled: 1, healthy: 3, degraded: 1, unreachable: 0 },
    tools: { total: 10, disabled: 0 },
    circuit_breakers: { open: 0, half_open: 0, closed: 0 },
    admin_users: 1,
    ...over,
  };
  return s;
}

const donutWidget = (breakdown: string): WidgetInstance => ({
  id: "w",
  type: "donut",
  w: 4,
  h: 2,
  options: { title: "Server health", breakdown },
});

describe("DonutWidget", () => {
  it("renders one arc per non-zero segment", () => {
    const wrapper = mount(DonutWidget, {
      props: { widget: donutWidget("clients.health"), stores: storesWith({}) },
    });
    expect(wrapper.findAll(".donut-arc")).toHaveLength(2);
    expect(wrapper.find(".donut-empty").exists()).toBe(false);
  });

  it("renders the empty state when the source has no data", () => {
    const wrapper = mount(DonutWidget, {
      props: { widget: donutWidget("clients.health"), stores: emptyStores() },
    });
    expect(wrapper.find(".donut-empty").exists()).toBe(true);
  });
});
