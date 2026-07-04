// Rebase coverage for ShareInstallLinkDialog.vue's move onto ModalShell.
// The one behavior worth a dedicated, real test (rather than just reasoning
// through it) is Esc-isolation between this dialog's outer ModalShell and
// the nested revoke ConfirmDialog's own ModalShell: both shells bind
// `@keydown.esc.stop`, so Escape while focus/dispatch is inside the nested
// confirm's overlay should close ONLY the confirm (stopPropagation keeps the
// event from ever reaching the outer overlay's own Esc listener). This file
// did not exist pre-rebase (src/components/ had no __tests__ dir before
// this change) — there is no prior coverage to preserve beyond what's
// asserted below.
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, flushPromises, type VueWrapper } from "@vue/test-utils";
import ShareInstallLinkDialog from "../ShareInstallLinkDialog.vue";
import type { BundleInstallLink } from "../../types/api";

const sampleLink: BundleInstallLink = {
  id: 1,
  bundleName: "demo-bundle",
  tokenPrefix: "abcd1234",
  mcpKeyId: 7,
  createdBy: null,
  createdAt: Date.now(),
  expiresAt: null,
  revokedAt: null,
  lastUsedAt: null,
};

const apiGet = vi.fn(async (path: string) => {
  if (path.includes("gateway-url")) return { publicUrl: null };
  if (path.includes("install-links")) return { items: [sampleLink] };
  return {};
});
const apiDelete = vi.fn(async (_path: string) => ({}));

vi.mock("@/composables/useApi", () => ({
  api: {
    get: (path: string) => apiGet(path),
    post: vi.fn(),
    delete: (path: string) => apiDelete(path),
  },
  ApiError: class ApiError extends Error {
    status: number;
    code: string;
    constructor(status: number, code: string, message: string) {
      super(message);
      this.status = status;
      this.code = code;
    }
  },
}));

let activeWrapper: VueWrapper | null = null;

function mountDialog(open: boolean) {
  activeWrapper = mount(ShareInstallLinkDialog, {
    props: { open, bundleName: "demo-bundle" },
    attachTo: document.body,
  });
  return activeWrapper;
}

afterEach(() => {
  activeWrapper?.unmount();
  activeWrapper = null;
  apiGet.mockClear();
  apiDelete.mockClear();
});

describe("ShareInstallLinkDialog (rebased on ModalShell)", () => {
  it("does not render ModalShell's panel when closed", () => {
    const wrapper = mountDialog(false);

    expect(wrapper.find(".overlay").exists()).toBe(false);
    expect(wrapper.find(".panel").exists()).toBe(false);
  });

  it("renders its content inside ModalShell's panel, with the aria-label moved to the ModalShell prop", async () => {
    const wrapper = mountDialog(false);
    await wrapper.setProps({ open: true });
    await flushPromises();

    const panel = wrapper.find(".panel");
    expect(panel.exists()).toBe(true);
    expect(panel.attributes("role")).toBe("dialog");
    expect(panel.attributes("aria-label")).toBe("Share install link");
    expect(panel.find(".dialog-head h2").text()).toBe("Share install link");
  });

  it("focuses the Close button — the first focusable element in the panel — on open", async () => {
    const wrapper = mountDialog(false);
    await wrapper.setProps({ open: true });
    await flushPromises();

    const closeBtn = wrapper.findAll("button").find((b) => b.text() === "Close");
    expect(closeBtn).toBeTruthy();
    expect(document.activeElement).toBe(closeBtn!.element);
  });

  it("still runs its own load()/loadGatewayUrl() data-loading side effect on every open", async () => {
    const wrapper = mountDialog(false);
    await wrapper.setProps({ open: true });
    await flushPromises();

    const firstCount = apiGet.mock.calls.length;
    expect(firstCount).toBeGreaterThan(0);
    expect(wrapper.text()).toContain("abcd1234");

    await wrapper.setProps({ open: false });
    await wrapper.setProps({ open: true });
    await flushPromises();

    expect(apiGet.mock.calls.length).toBeGreaterThan(firstCount);
  });

  it("Esc on the outer overlay closes the Share dialog when no nested confirm is open", async () => {
    const wrapper = mountDialog(false);
    await wrapper.setProps({ open: true });
    await flushPromises();

    expect(wrapper.findAll(".overlay")).toHaveLength(1); // no nested ConfirmDialog rendered yet

    await wrapper.find(".overlay").trigger("keydown", { key: "Escape" });

    expect(wrapper.emitted("close")).toHaveLength(1);
  });

  it("nested modal isolation: Esc while the revoke ConfirmDialog is open closes ONLY the confirm, not the outer Share dialog", async () => {
    const wrapper = mountDialog(false);
    await wrapper.setProps({ open: true });
    await flushPromises();

    // Open the nested revoke confirmation (ConfirmDialog, itself rebased onto
    // ModalShell) — this nests a second .overlay/.panel inside the outer one.
    const revokeBtn = wrapper.findAll("button").find((b) => b.text() === "Revoke");
    expect(revokeBtn).toBeTruthy();
    await revokeBtn!.trigger("click");
    await flushPromises();

    const overlaysWithConfirmOpen = wrapper.findAll(".overlay");
    expect(overlaysWithConfirmOpen).toHaveLength(2); // outer Share ModalShell + nested Confirm ModalShell
    expect(wrapper.find('[role="alertdialog"]').exists()).toBe(true);

    // Dispatch Escape on the INNER (nested) overlay specifically — this is
    // where a real Escape keypress would land while the confirm has focus,
    // since the nested overlay is a DOM descendant of the outer one and the
    // event bubbles from inner to outer. ModalShell's `@keydown.esc.stop`
    // binding on the inner overlay calls stopPropagation() before the outer
    // overlay's own `@keydown.esc.stop` listener ever sees the event.
    await overlaysWithConfirmOpen[1].trigger("keydown", { key: "Escape" });
    await flushPromises();

    // The nested confirm closed (ConfirmDialog emitted 'cancel', which the
    // parent wires to `pendingRevoke = null`) …
    expect(wrapper.find('[role="alertdialog"]').exists()).toBe(false);
    expect(wrapper.findAll(".overlay")).toHaveLength(1);
    // … but the outer Share dialog's own close was never emitted, and its
    // panel is still present/open.
    expect(wrapper.emitted("close")).toBeUndefined();
    expect(wrapper.find('.panel[aria-label="Share install link"]').exists()).toBe(true);
  });
});
