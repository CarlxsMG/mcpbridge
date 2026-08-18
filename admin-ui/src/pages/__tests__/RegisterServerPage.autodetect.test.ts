// The single-field register flow, end to end through the component: what the
// page infers from one paste, what it refuses to infer, and what it actually
// sends to POST /register.
//
// `utils/registerSource` has its own unit tests for the heuristics themselves;
// these cover the wiring that turns a detection into a payload — the part that
// silently sending the wrong `kind`, or a name the user never saw, would break.
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

const PREVIEW_OK = {
  count: 1,
  tools: [{ name: "list-users", method: "GET", endpoint: "/users", description: "" }],
};

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

/** Calls the request the page made to `path`, as the body it sent. */
function bodyFor(path: string): Record<string, unknown> {
  const call = apiPost.mock.calls.find(([p]) => p === path);
  expect(call, `no request to ${path}`).toBeDefined();
  return (call?.[1] ?? {}) as Record<string, unknown>;
}

describe("RegisterServerPage — one field", () => {
  it("detects an OpenAPI URL, derives the name and health URL, and leaves Advanced closed", async () => {
    const wrapper = mountPage();
    await wrapper.find("#r-source").setValue("https://api.payments.example.com/v3/openapi.json");

    expect(wrapper.text()).toContain("Detected: OpenAPI URL");
    // Derived values are stated on the page, not just written into the disclosure.
    expect(wrapper.find(".derived").text()).toContain("payments-example-com");
    expect(wrapper.find(".derived").text()).toContain("https://api.payments.example.com/v3/openapi.json");
    // Nothing is missing, so the disclosure stays shut.
    expect(wrapper.find("details.advanced").attributes("open")).toBeUndefined();
    // ...and the fields inside it carry the derived values, editable.
    expect(wrapper.find<HTMLInputElement>("#r-name").element.value).toBe("payments-example-com");
    expect(wrapper.find<HTMLInputElement>("#r-health").element.value).toBe(
      "https://api.payments.example.com/v3/openapi.json",
    );
  });

  it("sends the derived name and health URL with the OpenAPI discovery payload", async () => {
    apiPost.mockResolvedValue(PREVIEW_OK);
    const wrapper = mountPage();
    await wrapper.find("#r-source").setValue("https://api.example.com/openapi.json");
    await wrapper.find(".preview-row .btn-secondary").trigger("click");
    await flushPromises();

    apiPost.mockResolvedValue({ status: "registered", name: "example-com", tools_count: 1, source: "openapi" });
    await wrapper.find("form").trigger("submit");
    await flushPromises();

    expect(bodyFor("/register")).toEqual({
      name: "example-com",
      // The spec URL doubles as the health URL: the preview just proved it
      // answers 2xx, while the bare origin is an untested guess and a health
      // failure auto-evicts the client.
      health_url: "https://api.example.com/openapi.json",
      openapi_url: "https://api.example.com/openapi.json",
      include_tags: [],
      exclude_operations: [],
    });
  });

  it("tells the user to paste the URL when the field holds the OpenAPI document itself", async () => {
    // The reachable version of this: load openapi.json from disk, then pick the
    // obvious "OpenAPI" pill — which sent the whole document as `openapi_url` and
    // came back as a URL-validation error. There is no pill that could work, so
    // the form explains instead of offering one.
    const wrapper = mountPage();
    await wrapper.find("#r-source").setValue(JSON.stringify({ openapi: "3.1.0", info: { title: "P" }, paths: {} }));

    expect(wrapper.text()).toContain("needs the URL this document is served from");
    expect(wrapper.findAll(".choice")).toHaveLength(0);
    // Nothing resolved, so neither the preview nor the submit can fire.
    expect(wrapper.find(".preview-row .btn-secondary").attributes("disabled")).toBeDefined();
    expect(wrapper.find('button[type="submit"]').attributes("disabled")).toBeDefined();

    // Replacing it with the URL it is served from is the way out, and the form says so.
    await wrapper.find("#r-source").setValue("https://api.example.com/openapi.json");
    expect(wrapper.text()).toContain("Detected: OpenAPI URL");
  });

  it("keeps a name the user typed over the derived one", async () => {
    apiPost.mockResolvedValue(PREVIEW_OK);
    const wrapper = mountPage();
    await wrapper.find("#r-source").setValue("https://api.example.com/openapi.json");
    await wrapper.find("#r-name").setValue("payments-svc");
    // Changing the URL afterwards must not clobber the explicit name.
    await wrapper.find("#r-source").setValue("https://api.example.com/v2/openapi.json");
    expect(wrapper.find<HTMLInputElement>("#r-name").element.value).toBe("payments-svc");
  });

  it("refuses to guess between OpenAPI and MCP, and registers as MCP once told", async () => {
    const wrapper = mountPage();
    await wrapper.find("#r-source").setValue("https://mcp.example.com/mcp");

    expect(wrapper.text()).toContain("could be an OpenAPI document or an MCP server");
    const choices = wrapper.findAll(".choice").map((b) => b.text());
    expect(choices).toEqual(["OpenAPI URL", "MCP server"]);

    const mcpChoice = wrapper.findAll(".choice").find((b) => b.text() === "MCP server");
    await mcpChoice?.trigger("click");

    // MCP upstreams have no preview endpoint, so the preview gate does not apply.
    expect(wrapper.find(".preview-row").exists()).toBe(false);
    expect(wrapper.find('button[type="submit"]').attributes("disabled")).toBeUndefined();

    apiPost.mockResolvedValue({ status: "registered", name: "mcp-example-com", tools_count: 4, source: "mcp" });
    await wrapper.find("form").trigger("submit");
    await flushPromises();

    expect(bodyFor("/register")).toEqual({
      kind: "mcp",
      name: "mcp-example-com",
      mcp_url: "https://mcp.example.com/mcp",
      mcp_transport: "streamable-http",
    });
  });

  it("derives a name but no health URL for a GraphQL endpoint", async () => {
    apiPost.mockResolvedValue(PREVIEW_OK);
    const wrapper = mountPage();
    await wrapper.find("#r-source").setValue("https://api.example.com/graphql");

    // A bare GET on the operations endpoint is what many GraphQL servers refuse,
    // so proposing it as the health URL would register a server the health loop
    // then evicts. The field is left empty and the backend's own default applies.
    expect(wrapper.find<HTMLInputElement>("#r-health").element.value).toBe("");
    expect(wrapper.find<HTMLInputElement>("#r-name").element.value).toBe("example-com");

    await wrapper.find(".preview-row .btn-secondary").trigger("click");
    await flushPromises();
    expect(bodyFor("/admin-api/discovery/preview-graphql")).toEqual({
      graphql_url: "https://api.example.com/graphql",
      include_mutations: true,
    });

    apiPost.mockResolvedValue({ status: "registered", name: "example-com", tools_count: 1, source: "graphql" });
    await wrapper.find("form").trigger("submit");
    await flushPromises();

    expect(bodyFor("/register")).toEqual({
      kind: "graphql",
      name: "example-com",
      graphql_url: "https://api.example.com/graphql",
      health_url: undefined,
      include_mutations: true,
    });
  });

  it("opens Advanced by itself when nothing could be derived for a required field", async () => {
    const wrapper = mountPage();
    // A cURL paste carries no single host, so neither name nor health URL can be derived.
    await wrapper.find("#r-source").setValue("curl https://api.example.com/users");
    await flushPromises();

    expect(wrapper.text()).toContain("Detected: cURL command");
    expect(wrapper.find("details.advanced").attributes("open")).toBeDefined();
    expect(wrapper.find<HTMLInputElement>("#r-name").element.value).toBe("");
  });

  it("blocks submission on a name the backend would reject, at the field", async () => {
    apiPost.mockResolvedValue(PREVIEW_OK);
    const wrapper = mountPage();
    await wrapper.find("#r-source").setValue("https://api.example.com/openapi.json");
    await wrapper.find(".preview-row .btn-secondary").trigger("click");
    await flushPromises();

    await wrapper.find("#r-name").setValue("pay__ments");
    await wrapper.find(".preview-row .btn-secondary").trigger("click");
    await flushPromises();
    await wrapper.find("form").trigger("submit");
    await flushPromises();

    expect(apiPost.mock.calls.some(([p]) => p === "/register")).toBe(false);
    const nameField = wrapper.find("#r-name");
    expect(nameField.attributes("aria-invalid")).toBe("true");
    expect(wrapper.text()).toContain("cannot contain");
  });

  it("registers a curl paste as a REST client using the fields typed in Advanced", async () => {
    apiPost.mockResolvedValue(PREVIEW_OK);
    const wrapper = mountPage();
    await wrapper.find("#r-source").setValue("curl https://api.example.com/users");
    await wrapper.find("#r-name").setValue("payments-svc");
    await wrapper.find("#r-health").setValue("https://api.example.com/health");
    await wrapper.find(".preview-row .btn-secondary").trigger("click");
    await flushPromises();

    expect(bodyFor("/admin-api/discovery/preview")).toEqual({ curl_input: "curl https://api.example.com/users" });

    apiPost.mockResolvedValue({ status: "registered", name: "payments-svc", tools_count: 1, source: "manual" });
    await wrapper.find("form").trigger("submit");
    await flushPromises();

    expect(bodyFor("/register")).toEqual({
      name: "payments-svc",
      health_url: "https://api.example.com/health",
      curl_input: "curl https://api.example.com/users",
    });
  });

  it("hands off to the connect step instead of navigating away", async () => {
    apiPost.mockResolvedValue(PREVIEW_OK);
    const wrapper = mountPage();
    await wrapper.find("#r-source").setValue("https://api.example.com/openapi.json");
    await wrapper.find(".preview-row .btn-secondary").trigger("click");
    await flushPromises();

    apiPost.mockResolvedValue({ status: "registered", name: "example-com", tools_count: 1, source: "openapi" });
    await wrapper.find("form").trigger("submit");
    await flushPromises();

    expect(wrapper.find("form").exists()).toBe(false);
    expect(wrapper.find(".connect").exists()).toBe(true);
    expect(wrapper.text()).toContain("now connect your assistant");
  });
});
