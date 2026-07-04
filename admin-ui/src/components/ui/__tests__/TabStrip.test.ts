import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import { ClipboardCheck } from "lucide-vue-next";
import TabStrip from "../TabStrip.vue";

describe("TabStrip", () => {
  it("renders a button per tab and marks the active one", () => {
    const wrapper = mount(TabStrip, {
      props: {
        tabs: [
          { key: "pending", label: "Pending" },
          { key: "all", label: "All" },
        ],
        modelValue: "pending",
        ariaLabel: "Status",
      },
    });

    const buttons = wrapper.findAll(".tab-btn");
    expect(buttons).toHaveLength(2);
    expect(buttons[0].text()).toBe("Pending");
    expect(buttons[0].classes()).toContain("tab-active");
    expect(buttons[1].classes()).not.toContain("tab-active");
  });

  it("does not render an icon element when a tab has no icon", () => {
    const wrapper = mount(TabStrip, {
      props: {
        tabs: [{ key: "pending", label: "Pending" }],
        modelValue: "pending",
      },
    });

    expect(wrapper.find(".tab-btn svg").exists()).toBe(false);
    expect(wrapper.find(".tab-btn").text()).toBe("Pending");
  });

  it("renders the icon before the label when a tab provides one", () => {
    const wrapper = mount(TabStrip, {
      props: {
        tabs: [{ key: "pending", label: "Pending", icon: ClipboardCheck }],
        modelValue: "pending",
      },
    });

    const button = wrapper.find(".tab-btn");
    expect(button.find("svg").exists()).toBe(true);
    expect(button.text()).toBe("Pending");
  });

  it("updates the v-model when a tab is clicked", async () => {
    const wrapper = mount(TabStrip, {
      props: {
        tabs: [
          { key: "pending", label: "Pending" },
          { key: "all", label: "All" },
        ],
        modelValue: "pending",
      },
    });

    await wrapper.findAll(".tab-btn")[1].trigger("click");

    expect(wrapper.emitted("update:modelValue")).toEqual([["all"]]);
  });
});
