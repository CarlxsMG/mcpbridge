// #9: the playground result panel must be an ARIA live region so a screen
// reader announces the outcome, and it must escalate to an assertive alert on
// failure. The sr-only prefix conveys pass/fail without relying on colour.
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, flushPromises, type VueWrapper } from "@vue/test-utils";
import ServerDetailPlayground from "../ServerDetailPlayground.vue";
import type { ToolDetail } from "@/types/api";

const apiGet = vi.fn(async (_path: string) => ({ items: [] as unknown[] }));
const apiPost = vi.fn();

vi.mock("@/composables/useApi", () => ({
  api: { get: (p: string) => apiGet(p), post: (p: string, b: unknown) => apiPost(p, b) },
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

const tool: ToolDetail = {
  name: "search",
  method: "POST",
  endpoint: "/search",
  description: "",
  inputSchema: { properties: {}, required: [] },
  enabled: true,
};

let wrapper: VueWrapper | null = null;
async function mountPlayground() {
  wrapper = mount(ServerDetailPlayground, { props: { clientName: "acme", tool } });
  await flushPromises();
  return wrapper;
}
afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  apiGet.mockClear();
  apiPost.mockReset();
});

describe("ServerDetailPlayground result live region", () => {
  it("announces a success as a polite status region", async () => {
    apiPost.mockResolvedValueOnce({ content: [{ type: "text", text: "ok" }], isError: false });
    const w = await mountPlayground();
    await w.find("button.btn-primary").trigger("click");
    await flushPromises();

    const panel = w.find(".test-result");
    expect(panel.attributes("role")).toBe("status");
    expect(panel.attributes("aria-live")).toBe("polite");
    expect(panel.find(".sr-only").text()).toBe("Succeeded");
  });

  it("escalates a failure to an assertive alert region", async () => {
    apiPost.mockRejectedValueOnce(new Error("boom"));
    const w = await mountPlayground();
    await w.find("button.btn-primary").trigger("click");
    await flushPromises();

    const panel = w.find(".test-result");
    expect(panel.attributes("role")).toBe("alert");
    expect(panel.attributes("aria-live")).toBe("assertive");
    expect(panel.find(".sr-only").text()).toBe("Failed");
  });
});
