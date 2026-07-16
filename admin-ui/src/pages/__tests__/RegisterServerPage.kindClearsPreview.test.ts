// Regression coverage for finding #24: switching the server `kind` must clear a
// previously-discovered preview. Previewing under GraphQL then switching to REST
// used to leave previewTools populated, which (a) kept the REST submit button
// enabled — bypassing the preview-first gate — and (b) showed a stale, mislabeled
// tool table. RegisterServerPage now has `watch(kind, () => { previewTools = null; ... })`.
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, flushPromises, type VueWrapper } from "@vue/test-utils";
import RegisterServerPage from "../RegisterServerPage.vue";

const apiPost = vi.fn();

vi.mock("@/composables/useApi", () => ({
  api: { post: (path: string, body?: unknown) => apiPost(path, body) },
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

vi.mock("vue-router", () => ({
  useRouter: () => ({ push: vi.fn(), resolve: (p: string) => ({ href: p }) }),
  onBeforeRouteLeave: () => {},
}));

let activeWrapper: VueWrapper | null = null;
afterEach(() => {
  activeWrapper?.unmount();
  activeWrapper = null;
  apiPost.mockReset();
});

describe("RegisterServerPage — clears preview when kind changes", () => {
  it("drops the GraphQL preview (and re-gates the REST submit) after switching to REST", async () => {
    apiPost.mockResolvedValue({
      tools: [{ name: "getWidgets", method: "POST", endpoint: "/graphql" }],
    });
    const wrapper = mount(RegisterServerPage);

    // Switch to GraphQL, fill the URL, and preview.
    await wrapper.find('input[type="radio"][value="graphql"]').setValue();
    await wrapper.find("#r-graphql-url").setValue("https://api.example.com/graphql");
    await wrapper.find(".preview-row .btn-secondary").trigger("click");
    await flushPromises();

    // Preview succeeded: table is shown.
    expect(wrapper.find("#preview-table").exists()).toBe(true);

    // Switch to REST. The stale preview must be cleared...
    await wrapper.find('input[type="radio"][value="rest"]').setValue();

    // ...so the table is gone...
    expect(wrapper.find("#preview-table").exists()).toBe(false);
    // ...and the REST submit is re-gated (disabled until a fresh preview runs).
    const submit = wrapper.find('button[type="submit"]');
    expect(submit.attributes("disabled")).toBeDefined();
  });
});
