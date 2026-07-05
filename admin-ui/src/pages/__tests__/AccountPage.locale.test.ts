import { describe, expect, it, beforeEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { createRouter, createMemoryHistory } from "vue-router";
import AccountPage from "../AccountPage.vue";

const router = createRouter({
  history: createMemoryHistory(),
  routes: [{ path: "/account", component: AccountPage }],
});

describe("AccountPage locale switcher", () => {
  beforeEach(() => {
    localStorage.removeItem("mcpbridge:locale");
  });

  async function mountAccount() {
    const wrapper = mount(AccountPage, {
      global: {
        plugins: [router],
      },
    });
    await router.isReady();
    await flushPromises();
    return wrapper;
  }

  it("renders English by default", async () => {
    const wrapper = await mountAccount();
    expect(wrapper.text()).toContain("Language");
    expect(wrapper.text()).toContain("English");
  });

  it("switches to Spanish when the user picks Español", async () => {
    const wrapper = await mountAccount();
    const esRadio = wrapper.findAll<HTMLInputElement>("input[type=radio]").find((r) => r.element.value === "es");
    expect(esRadio, "Spanish radio option should exist").toBeDefined();
    await esRadio!.setValue(true);
    await flushPromises();

    // The Spanish copy replaces the English one in-place.
    expect(wrapper.text()).toContain("Idioma");
    expect(wrapper.text()).not.toContain("Language");
    expect(localStorage.getItem("mcpbridge:locale")).toBe("es");
    expect(document.documentElement.lang).toBe("es");
  });

  it("round-trips back to English", async () => {
    const wrapper = await mountAccount();
    const radios = wrapper.findAll<HTMLInputElement>("input[type=radio]");
    await radios.find((r) => r.element.value === "es")!.setValue(true);
    await flushPromises();
    await radios.find((r) => r.element.value === "en")!.setValue(true);
    await flushPromises();

    expect(wrapper.text()).toContain("Language");
    expect(localStorage.getItem("mcpbridge:locale")).toBe("en");
    expect(document.documentElement.lang).toBe("en");
  });
});
