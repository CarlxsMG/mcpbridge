// #6: the generated connect snippet must only exist for a target that is an
// actual member of the current scope's list. A preset/stale target that isn't in
// the list (e.g. a client name left selected after switching to bundle scope)
// must produce no snippet — just the "choose a target" hint — rather than a
// snippet pointing at a non-existent /mcp-custom/<name> endpoint.
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, flushPromises, RouterLinkStub, type VueWrapper } from "@vue/test-utils";
import ConnectClientDialog from "../ConnectClientDialog.vue";
import SelectMenu from "@/components/ui/SelectMenu.vue";

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

  // SelectMenu is a generic SFC, so findAllComponents falls back to the DOM
  // overload at the type level (the returned wrappers are real VueWrapper at
  // runtime). Narrow it so `.vm` is available. Order while scope !== "system":
  // [client, scope, target].
  const selectMenus = (w: VueWrapper) => w.findAllComponents(SelectMenu) as unknown as VueWrapper[];

  // #21/#22: switching the "Connect to" scope must clear the previously chosen
  // target so a name from the old scope (a client) can't linger in the new
  // scope's (bundle) dropdown as a stale, unselectable value.
  it("clears the chosen target when the user switches scope", async () => {
    const w = await openDialog({ presetScope: "client", presetName: "srv1" });

    const targetValue = () => selectMenus(w)[2].find(".select-menu-value").text();
    expect(targetValue()).toBe("srv1");
    expect(w.find(".snippet").exists()).toBe(true);

    // Simulate the user picking a different scope in the "Connect to" menu.
    selectMenus(w)[1].vm.$emit("update:modelValue", "bundle");
    await flushPromises();

    // The stale "srv1" must be gone — the target dropdown falls back to the
    // "— choose one —" placeholder, and no snippet is generated.
    expect(targetValue()).not.toBe("srv1");
    expect(targetValue()).toBe("— choose one —");
    expect(w.find(".snippet").exists()).toBe(false);
  });

  // Guard the round-1 behavior the fix must preserve: applying the parent's
  // presets on open sets scope + target together, and that programmatic scope
  // assignment must NOT be treated as a user switch that wipes the target —
  // even when opening genuinely changes the scope from its prior value.
  it("preserves an applied preset target even when reopening changes the scope", async () => {
    // First session: client scope, then close.
    const w = await openDialog({ presetScope: "client", presetName: "srv1" });
    await w.setProps({ open: false });
    await flushPromises();

    // The (still-mounted) dialog is re-pointed at a bundle preset and reopened,
    // so opening flips scope client -> bundle. The applyingPreset guard must
    // stop the scope watcher from wiping the just-applied "b1".
    await w.setProps({ presetScope: "bundle", presetName: "b1" });
    await w.setProps({ open: true });
    await flushPromises();

    expect(selectMenus(w)[2].find(".select-menu-value").text()).toBe("b1");
    expect(w.find(".snippet").exists()).toBe(true);
  });
});
