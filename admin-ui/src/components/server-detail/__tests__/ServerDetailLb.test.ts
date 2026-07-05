import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, flushPromises, type VueWrapper } from "@vue/test-utils";
import ServerDetailLb from "../ServerDetailLb.vue";
import type { LbConfig } from "@/types/api";

const apiGet = vi.fn();
const apiPost = vi.fn();
const apiPatch = vi.fn();
const apiPut = vi.fn();
const apiDelete = vi.fn();

vi.mock("@/composables/useApi", () => ({
  api: {
    get: (path: string) => apiGet(path),
    post: (path: string, body: unknown) => apiPost(path, body),
    patch: (path: string, body: unknown) => apiPatch(path, body),
    put: (path: string, body: unknown) => apiPut(path, body),
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

function makeLb(overrides: Partial<LbConfig> = {}): LbConfig {
  return {
    strategy: "round-robin",
    primaryWeight: 1,
    enabled: true,
    targets: [{ id: 1, baseUrl: "https://api-2.example.com", resolvedIp: "1.2.3.4", weight: 2, enabled: true }],
    ...overrides,
  };
}

let activeWrapper: VueWrapper | null = null;
async function mountLb(lb: LbConfig | null) {
  apiGet.mockResolvedValue({ lb });
  activeWrapper = mount(ServerDetailLb, { props: { clientName: "acme" } });
  await flushPromises();
  return activeWrapper;
}

afterEach(() => {
  activeWrapper?.unmount();
  activeWrapper = null;
  apiGet.mockReset();
  apiPost.mockReset();
  apiPatch.mockReset();
  apiPut.mockReset();
  apiDelete.mockReset();
});

describe("ServerDetailLb", () => {
  it("adds a pool target via POST to the upstreams sub-resource, then reloads the pool", async () => {
    apiPost.mockResolvedValueOnce(undefined);
    const wrapper = await mountLb(makeLb());
    apiGet.mockClear();

    const addForm = wrapper.findAll("form")[1];
    await addForm.find('input[type="url"]').setValue("https://api-3.example.com");
    await addForm.trigger("submit");
    await flushPromises();

    expect(apiPost).toHaveBeenCalledWith("/admin-api/clients/acme/lb/upstreams", {
      baseUrl: "https://api-3.example.com",
      weight: 1,
    });
    expect(apiGet).toHaveBeenCalledTimes(1);
  });

  it("updates a target's weight via PATCH to its /upstreams/:id sub-resource, then reloads the pool", async () => {
    apiPatch.mockResolvedValueOnce(undefined);
    const wrapper = await mountLb(makeLb());
    apiGet.mockClear();

    await wrapper.find("tbody tr input[type='number']").setValue(5);
    await flushPromises();

    expect(apiPatch).toHaveBeenCalledWith("/admin-api/clients/acme/lb/upstreams/1", { weight: 5 });
    expect(apiGet).toHaveBeenCalledTimes(1);
  });

  it("rejects a non-positive-integer weight locally, without calling the API", async () => {
    const wrapper = await mountLb(makeLb());

    await wrapper.find("tbody tr input[type='number']").setValue(0);

    expect(apiPatch).not.toHaveBeenCalled();
    expect(wrapper.find(".row-error").text()).toBe("Weight must be a whole number of at least 1.");
  });

  it("removes a target after confirming, via DELETE to its /upstreams/:id sub-resource", async () => {
    apiDelete.mockResolvedValueOnce(undefined);
    const wrapper = await mountLb(makeLb());
    apiGet.mockClear();

    await wrapper.find("tbody .link-btn.danger").trigger("click");
    expect(wrapper.find('[role="alertdialog"]').exists()).toBe(true);
    expect(apiDelete).not.toHaveBeenCalled();

    await wrapper.find('[role="alertdialog"] .btn-danger').trigger("click");
    await flushPromises();

    expect(apiDelete).toHaveBeenCalledWith("/admin-api/clients/acme/lb/upstreams/1");
    expect(apiGet).toHaveBeenCalledTimes(1);
  });

  it("does not remove the target when the confirmation is cancelled", async () => {
    const wrapper = await mountLb(makeLb());

    await wrapper.find("tbody .link-btn.danger").trigger("click");
    await wrapper.find('[role="alertdialog"] .btn-secondary').trigger("click");

    expect(wrapper.find('[role="alertdialog"]').exists()).toBe(false);
    expect(apiDelete).not.toHaveBeenCalled();
  });
});
