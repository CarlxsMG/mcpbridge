import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import ErrorNote from "../ErrorNote.vue";

describe("ErrorNote", () => {
  it("renders the message in the alert live region", () => {
    const wrapper = mount(ErrorNote, { props: { message: "Failed to load servers." } });

    const alert = wrapper.find('p.error[role="alert"]');
    expect(alert.exists()).toBe(true);
    expect(alert.text()).toBe("Failed to load servers.");
  });

  it("omits the ref line when there is no request id", () => {
    const wrapper = mount(ErrorNote, { props: { message: "Failed to load servers." } });

    expect(wrapper.find(".error-ref").exists()).toBe(false);
  });

  it("omits the ref line when the request id is explicitly null", () => {
    const wrapper = mount(ErrorNote, { props: { message: "Failed to load.", requestId: null } });

    expect(wrapper.find(".error-ref").exists()).toBe(false);
  });

  it("shows the request id with a label when one is present", () => {
    const wrapper = mount(ErrorNote, {
      props: { message: "Failed to update.", requestId: "0b7c2f10-1d4e-4a3f-9c11-8e2b6a5d4f30" },
    });

    const ref = wrapper.find(".error-ref");
    expect(ref.exists()).toBe(true);
    expect(ref.find("code").text()).toBe("0b7c2f10-1d4e-4a3f-9c11-8e2b6a5d4f30");
    expect(ref.text()).toContain("Request ref");
  });

  it("offers the id for copying — correlating with the audit log means pasting it elsewhere", () => {
    const wrapper = mount(ErrorNote, {
      props: { message: "Failed to update.", requestId: "req-abc" },
    });

    expect(wrapper.findComponent({ name: "CopyButton" }).props("text")).toBe("req-abc");
  });

  // The id must not be read out as part of the alert: a live region spelling
  // out a 36-character UUID buries the sentence that actually explains the
  // failure.
  it("keeps the request id outside the alert live region", () => {
    const wrapper = mount(ErrorNote, {
      props: { message: "Failed to update.", requestId: "req-abc" },
    });

    expect(wrapper.find('p.error[role="alert"]').text()).toBe("Failed to update.");
  });
});
