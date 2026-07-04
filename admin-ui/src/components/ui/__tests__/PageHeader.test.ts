import { describe, expect, it } from "vitest";
import { mount, RouterLinkStub } from "@vue/test-utils";
import PageHeader from "../PageHeader.vue";

describe("PageHeader", () => {
  it("renders the title and subtitle, with no back-link or meta slot by default", () => {
    const wrapper = mount(PageHeader, {
      props: { title: "Servers", subtitle: "Registered backend servers." },
      global: { stubs: { RouterLink: RouterLinkStub } },
    });

    expect(wrapper.find("h1").text()).toBe("Servers");
    expect(wrapper.find(".subtitle").text()).toBe("Registered backend servers.");
    expect(wrapper.find(".back-link").exists()).toBe(false);
    expect(wrapper.find(".header-meta").exists()).toBe(false);
  });

  it("does not render header-actions when no default slot content is passed", () => {
    const wrapper = mount(PageHeader, {
      props: { title: "Servers" },
      global: { stubs: { RouterLink: RouterLinkStub } },
    });

    expect(wrapper.find(".header-actions").exists()).toBe(false);
  });

  it("renders a back-link with the chevron icon and label when backLink is passed", () => {
    const wrapper = mount(PageHeader, {
      props: {
        title: "my-server",
        backLink: { to: "/servers", label: "Servers" },
      },
      global: { stubs: { RouterLink: RouterLinkStub } },
    });

    const backLink = wrapper.findComponent(RouterLinkStub);
    expect(backLink.exists()).toBe(true);
    expect(backLink.classes()).toContain("back-link");
    expect(backLink.props("to")).toBe("/servers");
    expect(backLink.text()).toContain("Servers");
  });

  it("renders #meta slot content between the title and subtitle when provided", () => {
    const wrapper = mount(PageHeader, {
      props: { title: "my-server", subtitle: "A subtitle" },
      slots: { meta: '<span class="badge">MCP</span>' },
      global: { stubs: { RouterLink: RouterLinkStub } },
    });

    const meta = wrapper.find(".header-meta");
    expect(meta.exists()).toBe(true);
    expect(meta.find(".badge").text()).toBe("MCP");
  });

  it("renders header-actions from the default slot", () => {
    const wrapper = mount(PageHeader, {
      props: { title: "Servers" },
      slots: { default: '<button type="button">Refresh</button>' },
      global: { stubs: { RouterLink: RouterLinkStub } },
    });

    expect(wrapper.find(".header-actions button").text()).toBe("Refresh");
  });
});
