import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, flushPromises, type VueWrapper } from "@vue/test-utils";
import ServerDetailResync from "../ServerDetailResync.vue";
import type { ClientDetail, DiscoveryPreview } from "@/types/api";

const apiPost = vi.fn();

vi.mock("@/composables/useApi", () => ({
  api: { post: (path: string, body: unknown) => apiPost(path, body) },
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

function makeDetail(overrides: Partial<ClientDetail> = {}): ClientDetail {
  return {
    name: "acme",
    enabled: true,
    live: true,
    status: null,
    ip: null,
    healthUrl: "https://acme.example.com/health",
    baseUrl: "https://acme.example.com",
    resolvedIp: null,
    retryNonSafeMethods: false,
    consecutiveFailures: null,
    circuitBreakerState: null,
    kind: "rest",
    mcpUrl: null,
    mcpTransport: null,
    teamId: null,
    tools: [
      { name: "search", method: "GET", endpoint: "/search", description: "", inputSchema: {}, enabled: true },
      { name: "fetch", method: "GET", endpoint: "/fetch", description: "", inputSchema: {}, enabled: true },
    ],
    ...overrides,
  };
}

let activeWrapper: VueWrapper | null = null;
function mountResync(detail: ClientDetail) {
  activeWrapper = mount(ServerDetailResync, { props: { detail } });
  return activeWrapper;
}

afterEach(() => {
  activeWrapper?.unmount();
  activeWrapper = null;
  apiPost.mockReset();
});

describe("ServerDetailResync", () => {
  it("diffs the previewed tools against the current tool list into added/removed/kept names", async () => {
    apiPost.mockResolvedValueOnce({
      count: 2,
      tools: [
        { name: "fetch", method: "GET", endpoint: "/fetch", description: "" },
        { name: "delete", method: "DELETE", endpoint: "/delete", description: "" },
      ],
    } satisfies DiscoveryPreview);
    const wrapper = mountResync(makeDetail());

    await wrapper.find(".ua-actions button").trigger("click");
    await wrapper.find(".field-inline input").setValue("https://api.example.com/openapi.json");
    await wrapper.find(".field-inline button").trigger("click");
    await flushPromises();

    expect(wrapper.find(".diff-add").text()).toBe("+ delete");
    expect(wrapper.find(".diff-rem").text()).toBe("− search");
    expect(wrapper.find(".diff-summary").text()).toContain("1");
    expect(wrapper.find(".diff-summary").text()).toContain("unchanged");
  });

  it("treats a tool present in both the current list and the preview as kept, not added or removed", async () => {
    apiPost.mockResolvedValueOnce({
      count: 2,
      tools: [
        { name: "search", method: "GET", endpoint: "/search", description: "" },
        { name: "fetch", method: "GET", endpoint: "/fetch", description: "" },
      ],
    } satisfies DiscoveryPreview);
    const wrapper = mountResync(makeDetail());

    await wrapper.find(".ua-actions button").trigger("click");
    await wrapper.find(".field-inline input").setValue("https://api.example.com/openapi.json");
    await wrapper.find(".field-inline button").trigger("click");
    await flushPromises();

    expect(wrapper.find(".diff-add").exists()).toBe(false);
    expect(wrapper.find(".diff-rem").exists()).toBe(false);
    expect(wrapper.find(".diff-summary").text()).toBe("0 added · 0 removed · 2 unchanged");
  });
});
