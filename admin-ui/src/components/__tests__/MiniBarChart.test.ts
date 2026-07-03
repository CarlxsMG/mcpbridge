import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import MiniBarChart from "../MiniBarChart.vue";

describe("MiniBarChart", () => {
  it("renders one bar row per entry without throwing", () => {
    const wrapper = mount(MiniBarChart, {
      props: {
        rows: [
          { label: "server-a", value: 42, hint: "req/s" },
          { label: "server-b", value: 7, danger: true },
        ],
      },
    });

    const rows = wrapper.findAll(".bar-row");
    expect(rows).toHaveLength(2);
    expect(wrapper.find(".bar-empty").exists()).toBe(false);
    expect(wrapper.find(".bar-fill.danger").exists()).toBe(true);
    expect(wrapper.text()).toContain("req/s");
  });

  it("renders the empty state for an empty rows array", () => {
    const wrapper = mount(MiniBarChart, { props: { rows: [] } });

    expect(wrapper.find(".bar-row").exists()).toBe(false);
    expect(wrapper.find(".bar-empty").exists()).toBe(true);
    expect(wrapper.text()).toContain("No data in this window.");
  });

  it("does not throw and floors bar width when every value is zero", () => {
    const wrapper = mount(MiniBarChart, {
      props: {
        rows: [
          { label: "a", value: 0 },
          { label: "b", value: 0 },
        ],
      },
    });

    const fills = wrapper.findAll(".bar-fill");
    expect(fills).toHaveLength(2);
    for (const fill of fills) {
      expect((fill.attributes("style") ?? "").replace(/\s/g, "")).toContain("width:2%");
    }
  });

  it("applies a custom valueFormat function", () => {
    const wrapper = mount(MiniBarChart, {
      props: {
        rows: [{ label: "a", value: 1500 }],
        valueFormat: (n: number) => `${n / 1000}k`,
      },
    });

    expect(wrapper.text()).toContain("1.5k");
  });
});
