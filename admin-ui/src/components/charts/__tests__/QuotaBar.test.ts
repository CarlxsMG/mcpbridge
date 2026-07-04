import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import QuotaBar from "../QuotaBar.vue";

describe("QuotaBar", () => {
  it("renders a signal-toned fill well under quota", () => {
    const wrapper = mount(QuotaBar, { props: { used: 10, quota: 100 } });

    expect(wrapper.find("rect.fill.signal").exists()).toBe(true);
    expect(wrapper.attributes("aria-label")).toBe("10 of 100 used");
  });

  it("renders a canary tone at 80%+ usage", () => {
    const wrapper = mount(QuotaBar, { props: { used: 85, quota: 100 } });

    expect(wrapper.find("rect.fill.canary").exists()).toBe(true);
  });

  it("renders a breach tone at/over 100% usage", () => {
    const wrapper = mount(QuotaBar, { props: { used: 120, quota: 100 } });

    expect(wrapper.find("rect.fill.breach").exists()).toBe(true);
  });

  it("renders the unlimited dashed style when quota is null", () => {
    const wrapper = mount(QuotaBar, { props: { used: 30, quota: null } });

    expect(wrapper.find("rect.fill.unlimited").exists()).toBe(true);
    expect(wrapper.attributes("aria-label")).toBe("30 used, unlimited quota");
  });

  it("does not throw and treats a zero quota as a breach", () => {
    const wrapper = mount(QuotaBar, { props: { used: 0, quota: 0 } });

    expect(wrapper.find("rect.fill.breach").exists()).toBe(true);
  });
});
