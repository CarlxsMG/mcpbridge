import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import TimeSeriesWidget from "../TimeSeriesWidget.vue";
import { emptyStores, type DashboardStores, type WidgetInstance } from "../widgetCatalog";
import type { UsageTimeseriesPoint } from "@/types/api";

function storesWith(points: UsageTimeseriesPoint[]): DashboardStores {
  const s = emptyStores();
  s.usageTimeseries = { bucketMs: 3_600_000, points };
  return s;
}

const seriesWidget = (series: string): WidgetInstance => ({
  id: "w",
  type: "timeseries",
  w: 8,
  h: 2,
  options: { title: "Calls & errors over time", series },
});

describe("TimeSeriesWidget", () => {
  it("renders one plotted point per timeseries bucket", () => {
    const wrapper = mount(TimeSeriesWidget, {
      props: {
        widget: seriesWidget("calls.errors"),
        stores: storesWith([
          { t: 1, calls: 10, errors: 1, avgMs: 100 },
          { t: 2, calls: 20, errors: 0, avgMs: 110 },
          { t: 3, calls: 5, errors: 2, avgMs: 90 },
        ]),
      },
    });
    const primaryPath = wrapper.findAll("path")[1];
    expect(primaryPath.attributes("d")?.match(/[ML]/g)).toHaveLength(3);
    expect(wrapper.find(".w-muted").exists()).toBe(false);
  });

  it("shows a placeholder message when the source is not loaded", () => {
    const wrapper = mount(TimeSeriesWidget, {
      props: { widget: seriesWidget("calls.errors"), stores: emptyStores() },
    });
    expect(wrapper.find(".w-muted").text()).toBe("No data.");
  });
});
