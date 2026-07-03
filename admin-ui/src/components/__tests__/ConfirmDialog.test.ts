import { afterEach, describe, expect, it } from "vitest";
import { mount, type VueWrapper } from "@vue/test-utils";
import { nextTick } from "vue";
import ConfirmDialog from "../ConfirmDialog.vue";

let activeWrapper: VueWrapper | null = null;

function mountDialog(open: boolean) {
  activeWrapper = mount(ConfirmDialog, {
    props: {
      open,
      title: "Delete server",
      message: "This cannot be undone.",
      confirmLabel: "Delete",
    },
    attachTo: document.body,
  });
  return activeWrapper;
}

afterEach(() => {
  activeWrapper?.unmount();
  activeWrapper = null;
});

describe("ConfirmDialog", () => {
  it("does not render the overlay when open is false", () => {
    const wrapper = mountDialog(false);

    expect(wrapper.find(".overlay").exists()).toBe(false);
  });

  it("toggles visibility when :open flips from false to true and back", async () => {
    const wrapper = mountDialog(false);
    expect(wrapper.find(".overlay").exists()).toBe(false);

    await wrapper.setProps({ open: true });
    expect(wrapper.find(".overlay").exists()).toBe(true);

    await wrapper.setProps({ open: false });
    expect(wrapper.find(".overlay").exists()).toBe(false);
  });

  it("focuses the cancel button on open, as the focus trap anchor", async () => {
    const wrapper = mountDialog(false);
    await wrapper.setProps({ open: true });
    await nextTick();

    expect(document.activeElement).toBe(wrapper.find(".btn-secondary").element);
  });

  it("emits confirm when the confirm button is clicked", async () => {
    const wrapper = mountDialog(true);

    await wrapper.find(".btn-primary").trigger("click");

    expect(wrapper.emitted("confirm")).toHaveLength(1);
    expect(wrapper.emitted("cancel")).toBeUndefined();
  });

  it("emits cancel when the cancel button is clicked", async () => {
    const wrapper = mountDialog(true);

    await wrapper.find(".btn-secondary").trigger("click");

    expect(wrapper.emitted("cancel")).toHaveLength(1);
    expect(wrapper.emitted("confirm")).toBeUndefined();
  });

  it("emits cancel on Escape while focus is inside the dialog", async () => {
    const wrapper = mountDialog(true);

    await wrapper.find(".overlay").trigger("keydown", { key: "Escape" });

    expect(wrapper.emitted("cancel")).toHaveLength(1);
  });

  it("traps Tab so focus cycles between cancel and confirm", async () => {
    const wrapper = mountDialog(false);
    await wrapper.setProps({ open: true });
    await nextTick();

    const cancelEl = wrapper.find(".btn-secondary").element as HTMLButtonElement;
    const confirmEl = wrapper.find(".btn-primary").element as HTMLButtonElement;

    // Focus starts on Cancel. Tab forward from Confirm should wrap to Cancel.
    confirmEl.focus();
    expect(document.activeElement).toBe(confirmEl);
    await wrapper.find(".overlay").trigger("keydown", { key: "Tab" });
    expect(document.activeElement).toBe(cancelEl);

    // Shift+Tab back from Cancel should wrap to Confirm.
    await wrapper.find(".overlay").trigger("keydown", { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(confirmEl);
  });

  it("returns focus to the previously focused element on close", async () => {
    const trigger = document.createElement("button");
    document.body.appendChild(trigger);
    trigger.focus();
    expect(document.activeElement).toBe(trigger);

    const wrapper = mountDialog(false);
    await wrapper.setProps({ open: true });
    await nextTick();
    expect(document.activeElement).not.toBe(trigger);

    await wrapper.setProps({ open: false });
    await nextTick();
    expect(document.activeElement).toBe(trigger);

    trigger.remove();
  });
});
