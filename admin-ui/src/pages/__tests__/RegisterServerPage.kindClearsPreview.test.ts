// Regression coverage for finding #24, carried across the single-field rewrite:
// a tool preview must never outlive the input that produced it.
//
// It used to be the `kind` radio group that could strand one — previewing under
// GraphQL and then switching to REST left the tool table on screen AND kept the
// preview-gated submit enabled, so a user could register a server against tools
// belonging to a different protocol. There is no kind toggle any more; the
// equivalent move is correcting the autodetected source, so the invariant is
// pinned there instead.
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, flushPromises, type VueWrapper } from "@vue/test-utils";
import RegisterServerPage from "../RegisterServerPage.vue";

const apiPost = vi.fn();

vi.mock("@/composables/useApi", () => ({
  api: {
    get: (path: string) => Promise.reject(new Error(`unexpected GET ${path}`)),
    post: (path: string, body?: unknown) => apiPost(path, body),
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

describe("RegisterServerPage — clears a preview when the source changes", () => {
  it("drops the GraphQL preview (and re-gates submit) after the source is corrected to OpenAPI", async () => {
    apiPost.mockResolvedValue({
      count: 1,
      tools: [{ name: "getWidgets", method: "POST", endpoint: "/graphql", description: "" }],
    });
    const wrapper = mount(RegisterServerPage);
    activeWrapper = wrapper;

    // A /graphql path autodetects as a GraphQL endpoint; preview it.
    await wrapper.find("#r-source").setValue("https://api.example.com/graphql");
    await wrapper.find(".preview-row .btn-secondary").trigger("click");
    await flushPromises();

    expect(wrapper.find("#preview-table").exists()).toBe(true);

    // Correct the detection to "OpenAPI URL" — one click behind "Not right?".
    await wrapper.find(".detected .link-btn").trigger("click");
    const openapiChoice = wrapper.findAll(".choice").find((b) => b.text() === "OpenAPI URL");
    expect(openapiChoice).toBeDefined();
    await openapiChoice?.trigger("click");

    // The stale preview is gone...
    expect(wrapper.find("#preview-table").exists()).toBe(false);
    // ...and submit is disabled again until a fresh preview runs.
    expect(wrapper.find('button[type="submit"]').attributes("disabled")).toBeDefined();
  });

  it("drops the preview when the pasted text itself changes", async () => {
    apiPost.mockResolvedValue({
      count: 1,
      tools: [{ name: "list-users", method: "GET", endpoint: "/users", description: "" }],
    });
    const wrapper = mount(RegisterServerPage);
    activeWrapper = wrapper;

    await wrapper.find("#r-source").setValue("https://api.example.com/openapi.json");
    await wrapper.find(".preview-row .btn-secondary").trigger("click");
    await flushPromises();
    expect(wrapper.find("#preview-table").exists()).toBe(true);

    await wrapper.find("#r-source").setValue("https://other.example.com/openapi.json");
    expect(wrapper.find("#preview-table").exists()).toBe(false);
    expect(wrapper.text()).toContain("Preview is out of date");
    expect(wrapper.find('button[type="submit"]').attributes("disabled")).toBeDefined();
  });
});
