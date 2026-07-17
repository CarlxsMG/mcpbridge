// Smoke coverage for SsoSettingsPage.vue: loads OIDC settings on mount and gates
// the save behind two required-field checks (issuer/clientId/redirectUri, then a
// resupplied client secret) before it ever PUTs.
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, flushPromises, RouterLinkStub, type VueWrapper } from "@vue/test-utils";
import SsoSettingsPage from "../SsoSettingsPage.vue";

const apiGet = vi.fn();
const apiPut = vi.fn();

vi.mock("@/composables/useApi", () => ({
  api: { get: (p: string) => apiGet(p), put: (p: string, b: unknown) => apiPut(p, b) },
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

let wrapper: VueWrapper | null = null;
async function mountPage() {
  apiGet.mockResolvedValue({ settings: null });
  wrapper = mount(SsoSettingsPage, { global: { stubs: { RouterLink: RouterLinkStub } } });
  await flushPromises();
  return wrapper;
}
afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  apiGet.mockReset();
  apiPut.mockReset();
});

describe("SsoSettingsPage", () => {
  it("loads settings on mount and renders the form", async () => {
    const w = await mountPage();
    expect(apiGet).toHaveBeenCalledWith("/admin-api/auth/oidc/settings");
    expect(w.find("#sso-issuer").exists()).toBe(true);
    expect(w.find("#sso-client-id").exists()).toBe(true);
  });

  it("blocks submit and surfaces an error when required URLs are blank", async () => {
    const w = await mountPage();
    await w.find("form.settings-form").trigger("submit");
    await flushPromises();
    expect(apiPut).not.toHaveBeenCalled();
    expect(w.find(".error").exists()).toBe(true);
  });

  it("blocks submit when the client secret is missing even if the URLs are filled", async () => {
    const w = await mountPage();
    await w.find("#sso-issuer").setValue("https://issuer.example.com");
    await w.find("#sso-client-id").setValue("cid");
    await w.find("#sso-redirect-uri").setValue("https://app.example.com/cb");
    await w.find("form.settings-form").trigger("submit");
    await flushPromises();
    expect(apiPut).not.toHaveBeenCalled();
    expect(w.find(".error").text()).toBeTruthy();
  });
});
