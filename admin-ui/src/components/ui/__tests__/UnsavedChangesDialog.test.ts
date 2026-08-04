// The unsaved-changes guard had NO test coverage at all before this, across the 14
// pages that hand-wired it — so the whole suite passing said nothing about whether
// leaving a dirty form still prompts. These cover all three branches, including the
// happy path (a pristine form must navigate straight through), which is the one a
// "prevent X from happening" change is most likely to break.
import { describe, expect, it } from "vitest";
import { defineComponent, h } from "vue";
import { mount, flushPromises } from "@vue/test-utils";
import { createRouter, createMemoryHistory, RouterView, type Router } from "vue-router";
import UnsavedChangesDialog from "../UnsavedChangesDialog.vue";

/**
 * Mounts the dialog inside a real route. It has to be a route component, not a bare
 * mount: onBeforeRouteLeave resolves against `matchedRouteKey`, which RouterView
 * provides — outside one, the guard silently never registers.
 *
 * The blocked-navigation cases `void` their push instead of awaiting it, deliberately:
 * a guard that opens the dialog does not call vue-router's `next` until the user picks
 * an option, so that promise is still pending when the assertions run. Awaiting it
 * would hang the test rather than fail it.
 */
async function mountInRoute(props: { dirty: boolean; bypass?: boolean; message?: string }) {
  const FormRoute = defineComponent({
    setup: () => () => h(UnsavedChangesDialog, { ...props }),
  });

  const router: Router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/form", component: FormRoute },
      { path: "/elsewhere", component: defineComponent({ setup: () => () => h("div", "elsewhere") }) },
    ],
  });

  const App = defineComponent({ setup: () => () => h(RouterView) });
  const wrapper = mount(App, { global: { plugins: [router] } });

  void router.push("/form");
  await router.isReady();
  await flushPromises();

  return { wrapper, router };
}

describe("UnsavedChangesDialog", () => {
  it("lets a pristine form navigate away with no prompt", async () => {
    const { wrapper, router } = await mountInRoute({ dirty: false });

    await router.push("/elsewhere");
    await flushPromises();

    expect(router.currentRoute.value.path).toBe("/elsewhere");
    expect(wrapper.find('[role="alertdialog"]').exists()).toBe(false);
  });

  it("blocks the navigation and opens the dialog when dirty", async () => {
    const { wrapper, router } = await mountInRoute({ dirty: true });

    void router.push("/elsewhere");
    await flushPromises();

    expect(router.currentRoute.value.path).toBe("/form");
    expect(wrapper.find('[role="alertdialog"]').exists()).toBe(true);
  });

  it("stays put when the discard is cancelled", async () => {
    const { wrapper, router } = await mountInRoute({ dirty: true });
    void router.push("/elsewhere");
    await flushPromises();

    await wrapper.find('[role="alertdialog"] .btn-secondary').trigger("click");
    await flushPromises();

    expect(router.currentRoute.value.path).toBe("/form");
    expect(wrapper.find('[role="alertdialog"]').exists()).toBe(false);
  });

  it("completes the navigation once the discard is confirmed", async () => {
    const { wrapper, router } = await mountInRoute({ dirty: true });
    void router.push("/elsewhere");
    await flushPromises();

    await wrapper.find('[role="alertdialog"] .btn-danger').trigger("click");
    await flushPromises();

    expect(router.currentRoute.value.path).toBe("/elsewhere");
  });

  it("does not prompt while bypassed, even when dirty", async () => {
    // The submit-in-flight and just-deleted cases: the form is dirty by definition,
    // but the navigation is the intended outcome.
    const { wrapper, router } = await mountInRoute({ dirty: true, bypass: true });

    await router.push("/elsewhere");
    await flushPromises();

    expect(router.currentRoute.value.path).toBe("/elsewhere");
    expect(wrapper.find('[role="alertdialog"]').exists()).toBe(false);
  });

  it("uses the shared message by default and the override when given one", async () => {
    const shared = await mountInRoute({ dirty: true });
    void shared.router.push("/elsewhere");
    await flushPromises();
    expect(shared.wrapper.find('[role="alertdialog"]').text()).toContain("You have unsaved changes.");

    const custom = await mountInRoute({ dirty: true, message: "You have unsaved tool selections." });
    void custom.router.push("/elsewhere");
    await flushPromises();
    expect(custom.wrapper.find('[role="alertdialog"]').text()).toContain("You have unsaved tool selections.");
  });
});
