import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import BarsWidget from "../BarsWidget.vue";
import { emptyStores, type DashboardStores, type WidgetInstance } from "../widgetCatalog";
import type { TopToolRow } from "@/types/api";

function storesWith(topTools: TopToolRow[]): DashboardStores {
  const s = emptyStores();
  s.topTools = topTools;
  return s;
}

const barsWidget = (ranking: string): WidgetInstance => ({
  id: "w",
  type: "bars",
  w: 6,
  h: 2,
  options: { title: "Top tools by calls", ranking },
});

describe("BarsWidget", () => {
  it("renders one bar row per ranked entry", () => {
    const wrapper = mount(BarsWidget, {
      props: {
        widget: barsWidget("topTools"),
        stores: storesWith([
          { client: "a", tool: "x", calls: 50, errors: 6, errorRate: 0.12, avgMs: 100, maxMs: 200 },
          { client: "b", tool: "y", calls: 12, errors: 0, errorRate: 0, avgMs: 80, maxMs: 150 },
        ]),
      },
    });
    expect(wrapper.findAll(".bar-row")).toHaveLength(2);
    expect(wrapper.find(".bar-fill.danger").exists()).toBe(true);
  });

  it("renders the empty state when the source has no rows", () => {
    const wrapper = mount(BarsWidget, {
      props: { widget: barsWidget("topTools"), stores: emptyStores() },
    });
    expect(wrapper.find(".bar-row").exists()).toBe(false);
    expect(wrapper.find(".bar-empty").exists()).toBe(true);
  });
});
