// Regression coverage for finding #25: the destructive-consequence message must
// be associated with the alertdialog via aria-describedby, so a screen reader
// announces it when the dialog opens. ConfirmDialog gives its message <p> a
// stable id and passes it to ModalShell's describedById prop.
import { afterEach, describe, expect, it } from "vitest";
import { mount, type VueWrapper } from "@vue/test-utils";
import ConfirmDialog from "../ConfirmDialog.vue";

let activeWrapper: VueWrapper | null = null;

afterEach(() => {
  activeWrapper?.unmount();
  activeWrapper = null;
});

describe("ConfirmDialog aria-describedby", () => {
  it("points the alertdialog's aria-describedby at the message paragraph", () => {
    activeWrapper = mount(ConfirmDialog, {
      props: {
        open: true,
        title: "Delete server",
        message: "This cannot be undone.",
        confirmLabel: "Delete",
      },
      attachTo: document.body,
    });

    const panel = activeWrapper.find('[role="alertdialog"]');
    const describedBy = panel.attributes("aria-describedby");
    expect(describedBy).toBeTruthy();

    // The referenced element exists inside the panel and carries the message.
    const message = activeWrapper.find('[role="alertdialog"] p');
    expect(message.exists()).toBe(true);
    expect(message.attributes("id")).toBe(describedBy);
    expect(message.text()).toBe("This cannot be undone.");
  });
});
