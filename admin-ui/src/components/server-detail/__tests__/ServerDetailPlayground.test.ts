// #9/#24: the playground result must be announced by an ARIA live region. The
// region is now PERSISTENT (always in the DOM) and carries ONLY the outcome
// word — a screen reader reliably announces a text change inside a region that
// was already present, whereas a v-if'd region can miss its own insertion. The
// region escalates to an assertive alert on failure; the colour-coded result
// blob renders OUTSIDE it so the announcement stays terse.
//
// #25: deleting a saved example is gated behind a confirmation dialog.
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, flushPromises, type VueWrapper } from "@vue/test-utils";
import ServerDetailPlayground from "../ServerDetailPlayground.vue";
import type { ToolDetail } from "@/types/api";

const apiGet = vi.fn(async (_path: string) => ({ items: [] as unknown[] }));
const apiPost = vi.fn();
const apiDelete = vi.fn(async (_path: string) => ({}));

vi.mock("@/composables/useApi", () => ({
  api: {
    get: (p: string) => apiGet(p),
    post: (p: string, b: unknown) => apiPost(p, b),
    delete: (p: string) => apiDelete(p),
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
  apiDelete.mockClear();
});

describe("ServerDetailPlayground result live region", () => {
  it("keeps a persistent, empty status region in the DOM before any run", async () => {
    const w = await mountPlayground();

    const live = w.find(".sr-only");
    expect(live.exists()).toBe(true);
    expect(live.attributes("role")).toBe("status");
    expect(live.attributes("aria-live")).toBe("polite");
    expect(live.text()).toBe("");
    // No visible result blob until a run produces one.
    expect(w.find(".test-result").exists()).toBe(false);
  });

  it("announces a success as a polite status region, with the blob outside it", async () => {
    apiPost.mockResolvedValueOnce({ content: [{ type: "text", text: "ok" }], isError: false });
    const w = await mountPlayground();
    await w.find("button.btn-primary").trigger("click");
    await flushPromises();

    const live = w.find(".sr-only");
    expect(live.attributes("role")).toBe("status");
    expect(live.attributes("aria-live")).toBe("polite");
    expect(live.text()).toBe("Succeeded");
    // The payload is rendered in a separate box, NOT inside the live region.
    expect(live.find("pre").exists()).toBe(false);
    expect(w.find(".test-result pre").text()).toBe("ok");
  });

  it("escalates a failure to an assertive alert region", async () => {
    apiPost.mockRejectedValueOnce(new Error("boom"));
    const w = await mountPlayground();
    await w.find("button.btn-primary").trigger("click");
    await flushPromises();

    const live = w.find(".sr-only");
    expect(live.attributes("role")).toBe("alert");
    expect(live.attributes("aria-live")).toBe("assertive");
    expect(live.text()).toBe("Failed");
  });
});

describe("ServerDetailPlayground example deletion", () => {
  it("requires confirmation before deleting a saved example", async () => {
    apiGet.mockResolvedValue({ items: [{ id: 7, label: "my example", args: {}, createdAt: 0, createdBy: null }] });
    const w = await mountPlayground();

    const delBtn = w.find(".ex-chip .link-btn.del");
    expect(delBtn.exists()).toBe(true);

    // Clicking × only arms the confirmation — it must NOT delete outright.
    await delBtn.trigger("click");
    await flushPromises();
    expect(apiDelete).not.toHaveBeenCalled();
    expect(w.find(".overlay").exists()).toBe(true);

    // Accepting the dialog performs the delete.
    await w.find(".overlay .btn-danger").trigger("click");
    await flushPromises();
    expect(apiDelete).toHaveBeenCalledTimes(1);
  });

  it("does not delete when the confirmation is cancelled", async () => {
    apiGet.mockResolvedValue({ items: [{ id: 7, label: "my example", args: {}, createdAt: 0, createdBy: null }] });
    const w = await mountPlayground();

    await w.find(".ex-chip .link-btn.del").trigger("click");
    await flushPromises();
    await w.find(".overlay .btn-secondary").trigger("click");
    await flushPromises();

    expect(apiDelete).not.toHaveBeenCalled();
    expect(w.find(".overlay").exists()).toBe(false);
  });
});
