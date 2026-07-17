// Smoke coverage for CompositeDetailPage.vue: loads a composite by route-prop
// name and pretty-prints its inputSchema and steps into the JSON editors, and
// syncs its description. RouterLink is stubbed (no router installed in the test).
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, flushPromises, RouterLinkStub, type VueWrapper } from "@vue/test-utils";
import CompositeDetailPage from "../CompositeDetailPage.vue";
import type { CompositeDetail } from "@/types/api";

const apiGet = vi.fn();

vi.mock("@/composables/useApi", () => ({
  api: { get: (p: string) => apiGet(p), patch: vi.fn(), delete: vi.fn() },
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

function makeComposite(): CompositeDetail {
  return { name: "comp1", description: "cd", enabled: true, inputSchema: {}, steps: [], createdAt: 0, updatedAt: 0 };
}

let wrapper: VueWrapper | null = null;
async function mountPage() {
  apiGet.mockResolvedValue(makeComposite());
  wrapper = mount(CompositeDetailPage, {
    props: { name: "comp1" },
    global: { stubs: { RouterLink: RouterLinkStub } },
  });
  await flushPromises();
  return wrapper;
}
afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  apiGet.mockReset();
});

describe("CompositeDetailPage", () => {
  it("loads the composite and pretty-prints its schema and steps into the editors", async () => {
    const w = await mountPage();
    expect(apiGet).toHaveBeenCalledWith("/admin-api/composites/comp1");
    expect(w.text()).toContain("comp1");
    expect((w.find("#composite-description").element as HTMLInputElement).value).toBe("cd");
    expect((w.find("#composite-schema").element as HTMLTextAreaElement).value).toBe("{}");
    expect((w.find("#composite-steps").element as HTMLTextAreaElement).value).toBe("[]");
  });
});
