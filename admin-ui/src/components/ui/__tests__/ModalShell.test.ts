import { afterEach, describe, expect, it } from "vitest";
import { mount, type VueWrapper } from "@vue/test-utils";
import { nextTick } from "vue";
import ModalShell from "../ModalShell.vue";

let activeWrapper: VueWrapper | null = null;

function mountShell(open: boolean, props: { alert?: boolean; maxWidth?: string } = {}) {
  activeWrapper = mount(ModalShell, {
    props: {
      open,
      label: "Test dialog",
      ...props,
    },
    slots: {
      default: '<button class="first-btn">First</button><button class="last-btn">Last</button>',
    },
    attachTo: document.body,
  });
  return activeWrapper;
}

afterEach(() => {
  activeWrapper?.unmount();
  activeWrapper = null;
});

describe("ModalShell", () => {
  it("renders nothing when open is false", () => {
    const wrapper = mountShell(false);

    expect(wrapper.find(".overlay").exists()).toBe(false);
    expect(wrapper.find(".panel").exists()).toBe(false);
  });

  it("renders the overlay and panel with role=dialog by default", () => {
    const wrapper = mountShell(true);

    expect(wrapper.find(".overlay").exists()).toBe(true);
    const panel = wrapper.find(".panel");
    expect(panel.exists()).toBe(true);
    expect(panel.attributes("role")).toBe("dialog");
    expect(panel.attributes("aria-modal")).toBe("true");
    expect(panel.attributes("aria-label")).toBe("Test dialog");
  });

  it("renders role=alertdialog when the alert prop is true", () => {
    const wrapper = mountShell(true, { alert: true });

    expect(wrapper.find(".panel").attributes("role")).toBe("alertdialog");
  });

  it("emits close when Escape is pressed on the overlay", async () => {
    const wrapper = mountShell(true);

    await wrapper.find(".overlay").trigger("keydown", { key: "Escape" });

    expect(wrapper.emitted("close")).toHaveLength(1);
  });

  it("traps Tab so focus cycles between the first and last focusable elements", async () => {
    const wrapper = mountShell(false);
    await wrapper.setProps({ open: true });
    await nextTick();

    const first = wrapper.find(".first-btn").element as HTMLButtonElement;
    const last = wrapper.find(".last-btn").element as HTMLButtonElement;

    last.focus();
    expect(document.activeElement).toBe(last);
    await wrapper.find(".overlay").trigger("keydown", { key: "Tab" });
    expect(document.activeElement).toBe(first);

    await wrapper.find(".overlay").trigger("keydown", { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it("focuses the first focusable element in the panel on open", async () => {
    const wrapper = mountShell(false);
    await wrapper.setProps({ open: true });
    await nextTick();

    expect(document.activeElement).toBe(wrapper.find(".first-btn").element);
  });

  it("returns focus to the previously focused element on close", async () => {
    const trigger = document.createElement("button");
    document.body.appendChild(trigger);
    trigger.focus();
    expect(document.activeElement).toBe(trigger);

    const wrapper = mountShell(false);
    await wrapper.setProps({ open: true });
    await nextTick();
    expect(document.activeElement).not.toBe(trigger);

    await wrapper.setProps({ open: false });
    await nextTick();
    expect(document.activeElement).toBe(trigger);

    trigger.remove();
  });

  it("does not emit close on a plain click on the overlay backdrop", async () => {
    const wrapper = mountShell(true);

    await wrapper.find(".overlay").trigger("click");

    expect(wrapper.emitted("close")).toBeUndefined();
  });
});
