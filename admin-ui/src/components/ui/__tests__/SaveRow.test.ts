import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import SaveRow from "../SaveRow.vue";

describe("SaveRow", () => {
  it("shows label when not saving", () => {
    const wrapper = mount(SaveRow, {
      props: { label: "Save tags", saving: false, saved: false },
    });

    expect(wrapper.find(".desc-save").text()).toBe("Save tags");
  });

  it("shows the default 'Saving…' text while saving when no savingLabel is given", () => {
    const wrapper = mount(SaveRow, {
      props: { label: "Save tags", saving: true, saved: false },
    });

    expect(wrapper.find(".desc-save").text()).toBe("Saving…");
  });

  it("shows a custom savingLabel while saving", () => {
    const wrapper = mount(SaveRow, {
      props: { label: "Save tags", savingLabel: "Working…", saving: true, saved: false },
    });

    expect(wrapper.find(".desc-save").text()).toBe("Working…");
  });

  it("disables the button while saving", async () => {
    const wrapper = mount(SaveRow, {
      props: { label: "Save tags", saving: false, saved: false },
    });
    expect(wrapper.find(".desc-save").attributes("disabled")).toBeUndefined();

    await wrapper.setProps({ saving: true });
    expect(wrapper.find(".desc-save").attributes("disabled")).toBeDefined();
  });

  it("emits save when the button is clicked", async () => {
    const wrapper = mount(SaveRow, {
      props: { label: "Save tags", saving: false, saved: false },
    });

    await wrapper.find(".desc-save").trigger("click");

    expect(wrapper.emitted("save")).toHaveLength(1);
  });

  it("shows the saved span only when saved is true", async () => {
    const wrapper = mount(SaveRow, {
      props: { label: "Save tags", saving: false, saved: false },
    });
    expect(wrapper.find(".save-ok").exists()).toBe(false);

    await wrapper.setProps({ saved: true });
    expect(wrapper.find(".save-ok").exists()).toBe(true);
    expect(wrapper.find(".save-ok").text()).toBe("Saved");
  });

  it("shows the error paragraph only when error is set", async () => {
    const wrapper = mount(SaveRow, {
      props: { label: "Save tags", saving: false, saved: false },
    });
    expect(wrapper.find(".field-error").exists()).toBe(false);

    await wrapper.setProps({ error: "Failed to save tags." });
    expect(wrapper.find(".field-error").exists()).toBe(true);
    expect(wrapper.find(".field-error").text()).toBe("Failed to save tags.");
  });
});
