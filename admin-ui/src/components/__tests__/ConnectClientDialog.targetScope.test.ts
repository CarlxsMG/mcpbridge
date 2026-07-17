// #6: the generated connect snippet must only exist for a target that is an
// actual member of the current scope's list. A preset/stale target that isn't in
// the list (e.g. a client name left selected after switching to bundle scope)
// must produce no snippet — just the "choose a target" hint — rather than a
// snippet pointing at a non-existent /mcp-custom/<name> endpoint.
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, flushPromises, RouterLinkStub, type VueWrapper } from "@vue/test-utils";
import ConnectClientDialog from "../ConnectClientDialog.vue";

const apiGet = vi.fn(async (path: string) => {
  if (path.includes("gateway-url")) return { publicUrl: null };
  if (path.includes("/clients")) return { items: [{ name: "srv1" }] };
  if (path.includes("/bundles")) return { items: [{ name: "b1" }] };
  if (path.includes("/mcp-keys")) return { items: [] };
  return {};
});

vi.mock("@/composables/useApi", () => ({
  api: { get: (path: string) => apiGet(path) },
}));

let wrapper: VueWrapper | null = null;
async function openDialog(props: Record<string, unknown>) {
  wrapper = mount(ConnectClientDialog, {
    props: { open: false, presetScope: "client", ...props },
    global: { stubs: { RouterLink: RouterLinkStub } },
    attachTo: document.body,
  });
  // The dialog only loads its client/bundle lists (and resets scope/target from
  // the presets) when `open` transitions to true — mirror how it's really used.
  await wrapper.setProps({ open: true });
  await flushPromises();
  return wrapper;
}

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  apiGet.mockClear();
});

describe("ConnectClientDialog target membership", () => {
  it("renders a snippet when the preset target is a real member of the scope", async () => {
    const w = await openDialog({ presetScope: "bundle", presetName: "b1" });
    expect(w.find(".snippet").exists()).toBe(true);
  });

  it("renders a snippet for a client-scope target that exists", async () => {
    const w = await openDialog({ presetScope: "client", presetName: "srv1" });
    expect(w.find(".snippet").exists()).toBe(true);
  });

  it("renders no snippet (only the hint) when the target is not a member of the scope", async () => {
    const w = await openDialog({ presetScope: "bundle", presetName: "ghost" });
    expect(w.find(".snippet").exists()).toBe(false);
    expect(w.find(".snippet-head").exists()).toBe(false);
  });
});
