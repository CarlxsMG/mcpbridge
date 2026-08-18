// A source the user picked must not outlive the input it was picked for.
//
// `detectSource` already refuses to register an inline OpenAPI document, and
// RegisterSourceField already answers it with an explanation and zero pills. The
// hole this file pins is one level up: an override standing from an EARLIER
// paste is not a detection, so it survived into the unregisterable state and
// kept the preview gate open. The reachable sequence is short and entirely
// reasonable — paste an extension-less URL, answer the "which is it?" question,
// then use the file picker sitting directly under the same field — and it ended
// in a URL-validation error printed next to a paragraph saying the input cannot
// be registered.
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

const SPEC_DOCUMENT = JSON.stringify({ openapi: "3.1.0", info: { title: "Payments" }, paths: {} });

let activeWrapper: VueWrapper | null = null;
afterEach(() => {
  activeWrapper?.unmount();
  activeWrapper = null;
  apiPost.mockReset();
});

function mountPage(): VueWrapper {
  const wrapper = mount(RegisterServerPage);
  activeWrapper = wrapper;
  return wrapper;
}

/** Picks the named source pill, failing loudly if the form is not offering it. */
async function pick(wrapper: VueWrapper, label: string): Promise<void> {
  const choice = wrapper.findAll(".choice").find((b) => b.text() === label);
  expect(choice, `no "${label}" choice offered`).toBeDefined();
  await choice?.trigger("click");
}

describe("RegisterServerPage — an override never outranks unregisterable input", () => {
  it("re-gates preview and submit when a chosen source meets a pasted OpenAPI document", async () => {
    const wrapper = mountPage();

    // An extension-less URL is the ambiguous case, so the form asks; answering
    // it sets the override that the rest of this test is about.
    await wrapper.find("#r-source").setValue("https://api.example.com/v3/service");
    await pick(wrapper, "OpenAPI URL");
    expect(wrapper.text()).toContain("Registering as: OpenAPI URL");
    expect(wrapper.find(".preview-row .btn-secondary").attributes("disabled")).toBeUndefined();

    // Now the file picker under the same field loads openapi.json itself.
    await wrapper.find("#r-source").setValue(SPEC_DOCUMENT);

    // The explanation is the only thing on offer: no source line, no pills.
    expect(wrapper.text()).toContain("needs the URL this document is served from");
    expect(wrapper.text()).not.toContain("Registering as:");
    expect(wrapper.findAll(".choice")).toHaveLength(0);

    // ...and neither action can fire. `trigger` is a no-op on a disabled
    // control, so the absent request is what proves the gate, not the attribute.
    expect(wrapper.find(".preview-row .btn-secondary").attributes("disabled")).toBeDefined();
    await wrapper.find(".preview-row .btn-secondary").trigger("click");
    await flushPromises();
    expect(wrapper.find('button[type="submit"]').attributes("disabled")).toBeDefined();
    await wrapper.find("form").trigger("submit");
    await flushPromises();

    // The specific regression: the spec body must never leave as `openapi_url`.
    expect(apiPost).not.toHaveBeenCalled();
  });

  it("still honours the chosen source once a registerable URL is pasted back", async () => {
    apiPost.mockResolvedValue({
      count: 1,
      tools: [{ name: "list-users", method: "GET", endpoint: "/users", description: "" }],
    });
    const wrapper = mountPage();

    await wrapper.find("#r-source").setValue("https://api.example.com/v3/service");
    await pick(wrapper, "MCP server");
    await wrapper.find("#r-source").setValue(SPEC_DOCUMENT);
    // Same dead end as above, reached from the other pill — and worse before the
    // fix: a standing `mcp` override took the "no preview endpoint" branch, so
    // the preview row disappeared entirely and left submit ungated on a spec body.
    expect(wrapper.find(".preview-row .btn-secondary").exists()).toBe(true);
    expect(wrapper.find(".preview-row .btn-secondary").attributes("disabled")).toBeDefined();
    expect(wrapper.find('button[type="submit"]').attributes("disabled")).toBeDefined();

    // Ignoring the override is not the same as discarding it: the choice was
    // deliberate and the user never took it back, so correcting the text — the
    // action the dead-end message asks for — must not also cost them the answer
    // they already gave to the ambiguity question.
    await wrapper.find("#r-source").setValue("https://api.example.com/v4/service");
    expect(wrapper.text()).toContain("Registering as: MCP server");
    // MCP has no preview endpoint, so its submit is ungated once a source resolves.
    expect(wrapper.find(".preview-row").exists()).toBe(false);
    expect(wrapper.find('button[type="submit"]').attributes("disabled")).toBeUndefined();

    apiPost.mockResolvedValue({ status: "registered", name: "example-com", tools_count: 2, source: "mcp" });
    await wrapper.find("form").trigger("submit");
    await flushPromises();

    const register = apiPost.mock.calls.find(([p]) => p === "/register");
    expect(register?.[1]).toEqual({
      kind: "mcp",
      name: "example-com",
      mcp_url: "https://api.example.com/v4/service",
      mcp_transport: "streamable-http",
    });
  });
});
