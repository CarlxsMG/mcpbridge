import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import StatWidget from "../StatWidget.vue";
import { emptyStores, type DashboardStores, type WidgetInstance } from "../widgetCatalog";

function storesWith(over: Partial<DashboardStores["overview"]> & object): DashboardStores {
  const s = emptyStores();
  s.overview = {
    clients: { live: 5, disabled: 1, healthy: 4, degraded: 1, unreachable: 1 },
    tools: { total: 42, disabled: 3 },
    circuit_breakers: { open: 2, half_open: 1, closed: 4 },
    admin_users: 3,
    ...over,
  };
  return s;
}

const statWidget = (options: WidgetInstance["options"]): WidgetInstance => ({
  id: "w",
  type: "stat",
  w: 3,
  h: 1,
  options,
});

describe("StatWidget", () => {
  it("renders the mapped value and label", () => {
    const wrapper = mount(StatWidget, {
      props: { widget: statWidget({ title: "Live servers", metric: "clients.live" }), stores: storesWith({}) },
    });
    expect(wrapper.find(".stat-label").text()).toBe("Live servers");
    expect(wrapper.find(".stat-value").text()).toBe("5");
  });

  it("derives a danger tone from thresholds when tone is auto", () => {
    const wrapper = mount(StatWidget, {
      props: {
        widget: statWidget({
          title: "Breakers open",
          metric: "breakers.open",
          tone: "auto",
          thresholds: { danger: 1 },
        }),
        stores: storesWith({}),
      },
    });
    expect(wrapper.find(".stat-card.tone-danger").exists()).toBe(true);
  });

  it("shows a placeholder dash when the source is not loaded", () => {
    const wrapper = mount(StatWidget, {
      props: { widget: statWidget({ title: "Live servers", metric: "clients.live" }), stores: emptyStores() },
    });
    expect(wrapper.find(".stat-value").text()).toBe("—");
  });
});
