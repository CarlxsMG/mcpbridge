// FormField is what ties a validation message to the control it belongs to.
// Before this, `<FieldError>` was rendered as a sibling: the message was announced
// (role="alert") but the input carried no aria-invalid and no aria-describedby, so a
// screen-reader user tabbing back through a failed form could not tell which fields
// were the broken ones. These pin the wiring, including the negative case — a field
// with no error must not claim to be invalid.
import { describe, expect, it } from "vitest";
import { defineComponent, h } from "vue";
import { mount } from "@vue/test-utils";
import FormField from "../FormField.vue";

/** Mounts a FormField whose slot spreads the wiring onto a real input, as pages do. */
function mountField(error?: string) {
  const Host = defineComponent({
    setup: () => () =>
      h(
        FormField,
        { label: "Monthly quota", for: "c-quota", error },
        { default: (field: Record<string, unknown>) => h("input", { id: "c-quota", ...field }) },
      ),
  });
  return mount(Host);
}

describe("FormField", () => {
  it("labels the control it names", () => {
    const wrapper = mountField();
    const label = wrapper.find("label");

    expect(label.attributes("for")).toBe("c-quota");
    expect(label.text()).toBe("Monthly quota");
  });

  it("adds no invalid-state wiring when there is no error", () => {
    const input = mountField().find("input");

    expect(input.attributes("aria-invalid")).toBeUndefined();
    expect(input.attributes("aria-describedby")).toBeUndefined();
  });

  it("marks the control invalid and points it at the message when there is one", () => {
    const wrapper = mountField("Must be a whole number of 1 or more.");
    const input = wrapper.find("input");

    expect(input.attributes("aria-invalid")).toBe("true");
    const describedBy = input.attributes("aria-describedby");
    expect(describedBy).toBe("c-quota-error");

    // The reference must actually resolve, and to the message the user needs.
    const target = wrapper.find(`#${describedBy}`);
    expect(target.exists()).toBe(true);
    expect(target.text()).toContain("Must be a whole number of 1 or more.");
  });

  it("keeps the message announced, so the failure is not silent", () => {
    // role="alert" comes from FieldError/ErrorNote; the association added here is in
    // addition to it, not a replacement — losing either regresses a different user.
    const wrapper = mountField("Name is required.");

    expect(wrapper.find('[role="alert"]').text()).toBe("Name is required.");
  });

  it("drops the wiring again once the error clears", async () => {
    const wrapper = mountField("Name is required.");
    expect(wrapper.find("input").attributes("aria-invalid")).toBe("true");

    await wrapper.setProps({});
    const cleared = mountField("");
    expect(cleared.find("input").attributes("aria-invalid")).toBeUndefined();
    expect(cleared.find('[role="alert"]').exists()).toBe(false);
  });
});
