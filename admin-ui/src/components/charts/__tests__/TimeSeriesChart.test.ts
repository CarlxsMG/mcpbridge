import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import TimeSeriesChart from "../TimeSeriesChart.vue";

describe("TimeSeriesChart", () => {
  it("renders a series with primary + secondary points without throwing", () => {
    const wrapper = mount(TimeSeriesChart, {
      props: {
        points: [
          { t: 1, v: 5 },
          { t: 2, v: 10 },
          { t: 3, v: 3 },
        ],
        secondaryPoints: [
          { t: 1, v: 1 },
          { t: 2, v: 4 },
          { t: 3, v: 2 },
        ],
        primaryLabel: "Requests",
        secondaryLabel: "Errors",
      },
    });

    expect(wrapper.find("svg.ts-svg").exists()).toBe(true);
    expect(wrapper.find(".ts-empty").exists()).toBe(false);
    expect(wrapper.text()).toContain("Requests");
    expect(wrapper.text()).toContain("Errors");
  });

  it("renders the empty state and no svg when points is an empty array", () => {
    const wrapper = mount(TimeSeriesChart, { props: { points: [] } });

    expect(wrapper.find(".ts-empty").exists()).toBe(true);
    expect(wrapper.find("svg.ts-svg").exists()).toBe(false);
    expect(wrapper.text()).toContain("No data in this window.");
  });

  it("does not throw when every point has a zero value", () => {
    const wrapper = mount(TimeSeriesChart, {
      props: {
        points: [
          { t: 1, v: 0 },
          { t: 2, v: 0 },
        ],
      },
    });

    expect(wrapper.find("svg.ts-svg").exists()).toBe(true);
  });

  it("renders a single point without a division-by-zero crash", () => {
    const wrapper = mount(TimeSeriesChart, {
      props: { points: [{ t: 1, v: 42 }] },
    });

    expect(wrapper.find("svg.ts-svg").exists()).toBe(true);
  });
});
