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

  const THREE = [
    { key: "a", label: "A" },
    { key: "b", label: "B" },
    { key: "c", label: "C" },
  ];

  it("activates the next/previous tab on ArrowRight/ArrowLeft, wrapping at the ends", async () => {
    const wrapper = mount(TabStrip, { props: { tabs: THREE, modelValue: "a" } });
    const buttons = wrapper.findAll(".tab-btn");

    await buttons[0].trigger("keydown", { key: "ArrowRight" });
    expect(wrapper.emitted("update:modelValue")?.at(-1)).toEqual(["b"]);

    // From the first tab, ArrowLeft wraps to the last.
    await buttons[0].trigger("keydown", { key: "ArrowLeft" });
    expect(wrapper.emitted("update:modelValue")?.at(-1)).toEqual(["c"]);
  });

  it("jumps to the first/last tab on Home/End", async () => {
    const wrapper = mount(TabStrip, { props: { tabs: THREE, modelValue: "b" } });
    const buttons = wrapper.findAll(".tab-btn");

    await buttons[1].trigger("keydown", { key: "End" });
    expect(wrapper.emitted("update:modelValue")?.at(-1)).toEqual(["c"]);

    await buttons[1].trigger("keydown", { key: "Home" });
    expect(wrapper.emitted("update:modelValue")?.at(-1)).toEqual(["a"]);
  });

  it("applies a roving tabindex — only the selected tab is in the tab order", () => {
    const wrapper = mount(TabStrip, { props: { tabs: THREE, modelValue: "b" } });
    const buttons = wrapper.findAll(".tab-btn");

    expect(buttons[0].attributes("tabindex")).toBe("-1");
    expect(buttons[1].attributes("tabindex")).toBe("0");
    expect(buttons[2].attributes("tabindex")).toBe("-1");
  });

  it("wires each tab's id + aria-controls to the shared panel when idBase is set", () => {
    const wrapper = mount(TabStrip, { props: { tabs: THREE, modelValue: "a", idBase: "demo" } });
    const first = wrapper.findAll(".tab-btn")[0];

    expect(first.attributes("id")).toBe("demo-tab-a");
    expect(first.attributes("aria-controls")).toBe("demo-panel");
  });

  it("omits tab ids + aria-controls when idBase is not provided", () => {
    const wrapper = mount(TabStrip, { props: { tabs: THREE, modelValue: "a" } });
    const first = wrapper.findAll(".tab-btn")[0];

    expect(first.attributes("id")).toBeUndefined();
    expect(first.attributes("aria-controls")).toBeUndefined();
  });
});
