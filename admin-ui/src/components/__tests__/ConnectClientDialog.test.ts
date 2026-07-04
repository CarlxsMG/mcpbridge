// Rebase coverage for ConnectClientDialog.vue's move onto ModalShell (see
// ModalShell.vue / ModalShell.test.ts for the shell's own focus-trap/Esc/
// focus-restore behavior, which is not re-tested here). This file only
// existed as a candidate for house-convention placement (src/components/
// had no __tests__ dir before this rebase) — it did not exist pre-rebase,
// so there is no prior coverage to preserve beyond what's asserted below.
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, flushPromises, RouterLinkStub, type VueWrapper } from "@vue/test-utils";
import ConnectClientDialog from "../ConnectClientDialog.vue";

const apiGet = vi.fn(async (path: string) => {
  if (path.includes("gateway-url")) return { publicUrl: null };
  if (path.includes("/clients")) return { items: [] };
  if (path.includes("/bundles")) return { items: [] };
  if (path.includes("/mcp-keys")) return { items: [] };
  return {};
});

vi.mock("@/composables/useApi", () => ({
  api: { get: (path: string) => apiGet(path) },
}));

let activeWrapper: VueWrapper | null = null;

function mountDialog(open: boolean) {
  activeWrapper = mount(ConnectClientDialog, {
    props: { open, presetScope: "aggregated" },
    global: { stubs: { RouterLink: RouterLinkStub } },
    attachTo: document.body,
  });
  return activeWrapper;
}

afterEach(() => {
  activeWrapper?.unmount();
  activeWrapper = null;
  apiGet.mockClear();
});

describe("ConnectClientDialog (rebased on ModalShell)", () => {
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
    expect(panel.attributes("aria-label")).toBe("Connect a client");
    expect(panel.find(".dialog-head h2").text()).toBe("Connect a client");
  });

  // The dialog's own hand-rolled trapFocus/closeBtn-focus logic is gone —
  // ModalShell focuses the first focusable element in the panel on open.
  // Close is that first focusable element (dialog-head's h2 isn't focusable),
  // so the net observable behavior is unchanged even though the *timing*
  // shifted (focus now lands as soon as the panel mounts, rather than after
  // loadContext's network calls resolve).
  it("focuses the Close button — the first focusable element in the panel — on open", async () => {
    const wrapper = mountDialog(false);
    await wrapper.setProps({ open: true });
    await flushPromises();

    const closeBtn = wrapper.findAll("button").find((b) => b.text() === "Close");
    expect(closeBtn).toBeTruthy();
    expect(document.activeElement).toBe(closeBtn!.element);
  });

  it("emits close on Escape (ModalShell's Esc handling, now the only Esc handling in this component)", async () => {
    const wrapper = mountDialog(false);
    await wrapper.setProps({ open: true });
    await flushPromises();

    await wrapper.find(".overlay").trigger("keydown", { key: "Escape" });

    expect(wrapper.emitted("close")).toHaveLength(1);
  });

  it("still runs its own loadContext data-loading side effect on every open, unrelated to ModalShell's focus watch", async () => {
    const wrapper = mountDialog(false);
    await wrapper.setProps({ open: true });
    await flushPromises();

    const firstCount = apiGet.mock.calls.length;
    expect(firstCount).toBeGreaterThan(0);

    await wrapper.setProps({ open: false });
    await wrapper.setProps({ open: true });
    await flushPromises();

    expect(apiGet.mock.calls.length).toBeGreaterThan(firstCount);
  });
});
