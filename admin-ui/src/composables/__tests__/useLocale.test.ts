import { describe, expect, it, beforeEach } from "vitest";
import { defineComponent, h, nextTick } from "vue";
import { mount } from "@vue/test-utils";
import { useLocale } from "../useLocale";
import { LOCALE_STORAGE_KEY } from "../../i18n";

// useLocale() calls vue-i18n's useI18n(), which requires a setup context — so
// we have to mount a tiny harness component and grab the composable's return
// value from inside it. The test-setup.ts already installs the i18n plugin on
// every mount, so no extra wiring here.
function mountLocaleHarness() {
  let captured: ReturnType<typeof useLocale> | null = null;
  const Harness = defineComponent({
    setup() {
      captured = useLocale();
      return () => h("div");
    },
  });
  const wrapper = mount(Harness);
  return {
    wrapper,
    get api() {
      if (!captured) throw new Error("useLocale not initialized");
      return captured;
    },
  };
}

describe("useLocale", () => {
  beforeEach(() => {
    localStorage.removeItem(LOCALE_STORAGE_KEY);
    document.documentElement.removeAttribute("lang");
  });

  it("starts at the default locale when no preference is stored", () => {
    const { api } = mountLocaleHarness();
    expect(api.locale.value).toBe("en");
  });

  it("reads a stored preference", () => {
    localStorage.setItem(LOCALE_STORAGE_KEY, "es");
    const { api } = mountLocaleHarness();
    expect(api.locale.value).toBe("es");
  });

  it("ignores an unsupported stored value", () => {
    localStorage.setItem(LOCALE_STORAGE_KEY, "klingon");
    const { api } = mountLocaleHarness();
    expect(api.locale.value).toBe("en");
  });

  it("setLocale persists to localStorage", async () => {
    const { api } = mountLocaleHarness();
    api.setLocale("es");
    await nextTick();
    expect(api.locale.value).toBe("es");
    expect(localStorage.getItem(LOCALE_STORAGE_KEY)).toBe("es");
  });

  it("setLocale syncs the <html lang> attribute (a11y)", async () => {
    const { api } = mountLocaleHarness();
    api.setLocale("es");
    await nextTick();
    expect(document.documentElement.lang).toBe("es");
    api.setLocale("en");
    await nextTick();
    expect(document.documentElement.lang).toBe("en");
  });

  it("setLocale rejects unsupported values without throwing", () => {
    const { api } = mountLocaleHarness();
    const before = api.locale.value;
    api.setLocale("klingon" as never);
    expect(api.locale.value).toBe(before);
    expect(localStorage.getItem(LOCALE_STORAGE_KEY)).toBeNull();
  });

  it("exposes both supported locales", () => {
    const { api } = mountLocaleHarness();
    expect(api.locales).toEqual(["en", "es"]);
  });
});
