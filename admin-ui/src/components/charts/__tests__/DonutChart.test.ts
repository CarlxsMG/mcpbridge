import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import DonutChart from "../DonutChart.vue";

describe("DonutChart", () => {
  it("renders arcs and legend entries for a non-empty segment list", () => {
    const wrapper = mount(DonutChart, {
      props: {
        segments: [
          { label: "Allowed", value: 8, color: "#2ecc71" },
          { label: "Denied", value: 2, color: "#e74c3c" },
        ],
      },
    });

    expect(wrapper.find("svg").exists()).toBe(true);
    expect(wrapper.findAll(".donut-arc")).toHaveLength(2);
    expect(wrapper.findAll(".chart-legend li")).toHaveLength(2);
    expect(wrapper.find(".donut-empty").exists()).toBe(false);
  });

  it("renders the empty state for an empty segment array", () => {
    const wrapper = mount(DonutChart, { props: { segments: [] } });

    expect(wrapper.find("svg").exists()).toBe(false);
    expect(wrapper.find(".donut-empty").exists()).toBe(true);
    expect(wrapper.text()).toContain("No data.");
  });

  it("renders the empty state when every segment value is zero", () => {
    const wrapper = mount(DonutChart, {
      props: {
        segments: [
          { label: "A", value: 0, color: "#000" },
          { label: "B", value: 0, color: "#fff" },
        ],
      },
    });

    expect(wrapper.find("svg").exists()).toBe(false);
    expect(wrapper.find(".donut-empty").exists()).toBe(true);
  });

  it("respects an explicit centerLabel override", () => {
    const wrapper = mount(DonutChart, {
      props: {
        segments: [{ label: "A", value: 5, color: "#000" }],
        centerLabel: "5 total",
      },
    });

    expect(wrapper.find(".donut-total").text()).toBe("5 total");
  });
});
