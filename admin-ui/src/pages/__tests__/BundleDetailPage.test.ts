// Smoke coverage for BundleDetailPage.vue: loads a bundle by route-prop name and
// syncs its description + tool list into the editable drafts. Heavy children that
// make their own network calls (BundleToolPicker) or are closed dialogs are
// stubbed; RouterLink is stubbed since no router is installed.
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, flushPromises, RouterLinkStub, type VueWrapper } from "@vue/test-utils";
import BundleDetailPage from "../BundleDetailPage.vue";
import type { BundleDetail } from "@/types/api";

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

function makeBundle(): BundleDetail {
  return {
    name: "b1",
    description: "desc",
    enabled: true,
    createdAt: 0,
    updatedAt: 0,
    tools: [{ client: "c", tool: "t" }],
  };
}

let wrapper: VueWrapper | null = null;
async function mountPage() {
  apiGet.mockResolvedValue(makeBundle());
  wrapper = mount(BundleDetailPage, {
    props: { name: "b1" },
    global: {
      stubs: {
        RouterLink: RouterLinkStub,
        BundleToolPicker: true,
        ConnectClientDialog: true,
        ShareInstallLinkDialog: true,
      },
    },
  });
  await flushPromises();
  return wrapper;
}
afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  apiGet.mockReset();
});

describe("BundleDetailPage", () => {
  it("loads the bundle and syncs its name, description and tool count", async () => {
    const w = await mountPage();
    expect(apiGet).toHaveBeenCalledWith("/admin-api/bundles/b1");
    expect(w.text()).toContain("b1");
    expect((w.find("#bundle-description").element as HTMLInputElement).value).toBe("desc");
    expect(w.find("h2").text()).toContain("1");
  });
});
