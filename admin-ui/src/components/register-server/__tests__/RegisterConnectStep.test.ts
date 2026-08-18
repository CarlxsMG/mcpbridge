// The post-registration step: a config the user can paste without visiting the
// Keys page, and a key scoped to the server that was just created.
//
// Three things here are easy to get wrong in a way no type catches. Minting must
// not happen on render — the data plane runs in "open mode" until the first
// managed key exists anywhere, so an automatic mint would flip a process-wide
// auth mode as a side effect of a page appearing. The key must be scoped to the
// new client (an unscoped one reaches every other tenant's tools). And the
// generated instructions must stop telling the user to replace a placeholder
// once the real key is already in the snippet.
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, flushPromises, RouterLinkStub, type VueWrapper } from "@vue/test-utils";
import RegisterConnectStep from "../RegisterConnectStep.vue";

const apiGet = vi.fn();
const apiPost = vi.fn();

// `ApiError` is exported too: utils/errors.ts narrows on it to decide whether a
// failure carries a translatable code, so a mock without it throws on the
// mint-refused path rather than rendering the fallback.
vi.mock("@/composables/useApi", () => ({
  api: {
    get: (path: string) => apiGet(path),
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

let activeWrapper: VueWrapper | null = null;

async function mountStep(): Promise<VueWrapper> {
  const wrapper = mount(RegisterConnectStep, {
    props: { serverName: "payments-svc", toolsCount: 3 },
    global: { stubs: { RouterLink: RouterLinkStub } },
  });
  activeWrapper = wrapper;
  await flushPromises();
  return wrapper;
}

afterEach(() => {
  activeWrapper?.unmount();
  activeWrapper = null;
  apiGet.mockReset();
  apiPost.mockReset();
});

/** Clicks "Create an API key for this server" and settles the request. */
async function mint(wrapper: VueWrapper): Promise<void> {
  await wrapper.find(".key-row .btn-secondary").trigger("click");
  await flushPromises();
}

describe("RegisterConnectStep", () => {
  it("shows a usable config immediately and mints nothing until asked", async () => {
    apiGet.mockResolvedValue({ publicUrl: "https://gw.example.com" });

    const wrapper = await mountStep();

    expect(apiPost).not.toHaveBeenCalled();
    const snippet = wrapper.find(".snippet").text();
    expect(snippet).toContain("https://gw.example.com/mcp/payments-svc");
    expect(snippet).toContain("<YOUR_MCP_API_KEY>");
    // The snippet is the whole point of the step, so what was registered is
    // stated next to it.
    expect(wrapper.text()).toContain("3 tools discovered");
  });

  it("mints a key confined to the new server and puts it straight into the snippet", async () => {
    apiGet.mockResolvedValue({ publicUrl: "https://gw.example.com" });
    apiPost.mockResolvedValue({ id: 7, label: "payments-svc quick connect", key: "mcp_live_abc123" });

    const wrapper = await mountStep();
    await mint(wrapper);

    const [path, body] = apiPost.mock.calls[0] as [string, Record<string, unknown>];
    expect(path).toBe("/admin-api/mcp-keys");
    expect(body.scopes).toEqual({ clients: ["payments-svc"] });

    const snippet = wrapper.find(".snippet").text();
    expect(snippet).toContain("mcp_live_abc123");
    expect(snippet).not.toContain("<YOUR_MCP_API_KEY>");
  });

  it("drops the 'replace the placeholder' step once a real key is in the snippet", async () => {
    apiGet.mockResolvedValue({ publicUrl: null });
    apiPost.mockResolvedValue({ id: 7, label: "payments-svc quick connect", key: "mcp_live_abc123" });

    const wrapper = await mountStep();
    const before = wrapper.findAll(".instructions li").map((li) => li.text());
    expect(before.some((line) => line.includes("<YOUR_MCP_API_KEY>"))).toBe(true);

    await mint(wrapper);

    const after = wrapper.findAll(".instructions li").map((li) => li.text());
    expect(after.length).toBe(before.length - 1);
    expect(after.some((line) => line.includes("Replace"))).toBe(false);
    // The credential appears exactly once — in the copyable snippet.
    expect(after.some((line) => line.includes("mcp_live_abc123"))).toBe(false);
  });

  it("keeps the placeholder config when minting is refused, and says why", async () => {
    apiGet.mockResolvedValue({ publicUrl: null });
    // Registering only needs the operator role; minting a key needs admin. An
    // operator therefore reaches this step legitimately and must still get a
    // usable config.
    apiPost.mockRejectedValue(new Error("This action requires the admin role"));

    const wrapper = await mountStep();
    await mint(wrapper);

    expect(wrapper.find(".snippet").text()).toContain("<YOUR_MCP_API_KEY>");
    const instructions = wrapper.findAll(".instructions li").map((li) => li.text());
    expect(instructions.some((line) => line.includes("<YOUR_MCP_API_KEY>"))).toBe(true);
    expect(wrapper.text()).toContain("Could not create an API key for this server.");
  });

  it("points the snippet at the gateway's own origin when no public URL is configured", async () => {
    apiGet.mockResolvedValue({ publicUrl: null });

    const wrapper = await mountStep();

    expect(wrapper.find(".snippet").text()).toContain(`${window.location.origin}/mcp/payments-svc`);
  });

  it("asks the parent to reset rather than navigating to the route it is already on", async () => {
    apiGet.mockResolvedValue({ publicUrl: null });

    const wrapper = await mountStep();
    await wrapper.find(".actions .link-btn").trigger("click");

    expect(wrapper.emitted("addAnother")).toHaveLength(1);
  });
});
