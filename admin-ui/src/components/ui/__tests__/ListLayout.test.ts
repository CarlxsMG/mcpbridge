import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import ListLayout from "../ListLayout.vue";

describe("ListLayout", () => {
  it("shows the error paragraph when error is a non-empty string", () => {
    const wrapper = mount(ListLayout, {
      props: { loading: false, empty: false, error: "Failed to load servers." },
    });

    const error = wrapper.find('p.error[role="alert"]');
    expect(error.exists()).toBe(true);
    expect(error.text()).toBe("Failed to load servers.");
  });

  it("does not show the error paragraph when error is undefined", () => {
    const wrapper = mount(ListLayout, {
      props: { loading: false, empty: false },
    });

    expect(wrapper.find('p.error[role="alert"]').exists()).toBe(false);
  });

  it("does not show the error paragraph when error is an empty string", () => {
    const wrapper = mount(ListLayout, {
      props: { loading: false, empty: false, error: "" },
    });

    expect(wrapper.find('p.error[role="alert"]').exists()).toBe(false);
  });

  it("shows SignalLoader when loading is true", () => {
    const wrapper = mount(ListLayout, {
      props: { loading: true, empty: false },
    });

    expect(wrapper.find(".signal-loader").exists()).toBe(true);
  });

  it("shows both the error paragraph and the loader when error and loading are both set (they are independent v-ifs, not mutually exclusive)", () => {
    const wrapper = mount(ListLayout, {
      props: { loading: true, empty: false, error: "Failed to load servers." },
    });

    expect(wrapper.find('p.error[role="alert"]').exists()).toBe(true);
    expect(wrapper.find(".signal-loader").exists()).toBe(true);
  });

  it("shows the #empty slot when empty is true and not loading", () => {
    const wrapper = mount(ListLayout, {
      props: { loading: false, empty: true },
      slots: { empty: '<div class="empty-marker">Nothing here</div>' },
    });

    expect(wrapper.find(".empty-marker").exists()).toBe(true);
    expect(wrapper.find(".signal-loader").exists()).toBe(false);
  });

  it("does not show the #empty slot while loading, even if empty is true", () => {
    const wrapper = mount(ListLayout, {
      props: { loading: true, empty: true },
      slots: { empty: '<div class="empty-marker">Nothing here</div>' },
    });

    expect(wrapper.find(".empty-marker").exists()).toBe(false);
    expect(wrapper.find(".signal-loader").exists()).toBe(true);
  });

  it("shows the default slot when neither loading nor empty", () => {
    const wrapper = mount(ListLayout, {
      props: { loading: false, empty: false },
      slots: { default: '<div class="content-marker">Rows here</div>' },
    });

    expect(wrapper.find(".content-marker").exists()).toBe(true);
    expect(wrapper.find(".signal-loader").exists()).toBe(false);
    expect(wrapper.find(".empty-marker").exists()).toBe(false);
  });

  it("does not show the default slot when loading or empty", () => {
    const wrapper = mount(ListLayout, {
      props: { loading: false, empty: true },
      slots: {
        empty: '<div class="empty-marker">Nothing here</div>',
        default: '<div class="content-marker">Rows here</div>',
      },
    });

    expect(wrapper.find(".content-marker").exists()).toBe(false);
    expect(wrapper.find(".empty-marker").exists()).toBe(true);
  });
});
