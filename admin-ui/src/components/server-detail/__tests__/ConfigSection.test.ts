import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import ConfigSection from "../ConfigSection.vue";

describe("ConfigSection", () => {
  it("renders the title in an h2 and the default slot content", () => {
    const wrapper = mount(ConfigSection, {
      props: { title: "Upstream authentication" },
      slots: { default: '<p class="ua-status">Not configured.</p>' },
    });

    expect(wrapper.find("h2").text()).toBe("Upstream authentication");
    expect(wrapper.find(".ua-status").text()).toBe("Not configured.");
  });

  it("does not render .ua-actions when no actions slot content is passed", () => {
    const wrapper = mount(ConfigSection, {
      props: { title: "Team ownership" },
    });

    expect(wrapper.find(".ua-actions").exists()).toBe(false);
  });

  it("renders actions slot content inside .ua-actions when provided", () => {
    const wrapper = mount(ConfigSection, {
      props: { title: "Upstream authentication" },
      slots: { actions: '<button type="button" class="link-btn danger">Clear</button>' },
    });

    const actions = wrapper.find(".ua-actions");
    expect(actions.exists()).toBe(true);
    expect(actions.find("button").text()).toBe("Clear");
  });
});
