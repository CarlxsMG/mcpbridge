// ServerDetailToolsTable.vue calls useRouter() unconditionally (for the guard-editor
// link), so it needs a real router installed rather than a bare mount — same style as
// composables/__tests__/useQueryFilters.test.ts.
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, flushPromises, type VueWrapper } from "@vue/test-utils";
import { createRouter, createMemoryHistory, type Router } from "vue-router";
import ServerDetailToolsTable from "../ServerDetailToolsTable.vue";
import { ApiError } from "@/composables/useApi";
import type { ToolDetail } from "@/types/api";

const apiPatch = vi.fn();

vi.mock("@/composables/useApi", () => ({
  api: { patch: (path: string, body: unknown) => apiPatch(path, body) },
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

function makeRouter(): Router {
  return createRouter({
    history: createMemoryHistory(),
    routes: [{ path: "/:pathMatch(.*)*", component: { template: "<div/>" } }],
  });
}

function makeTool(overrides: Partial<ToolDetail> = {}): ToolDetail {
  return {
    name: "search",
    method: "GET",
    endpoint: "/search",
    description: "",
    inputSchema: {},
    enabled: true,
    ...overrides,
  };
}

let activeWrapper: VueWrapper | null = null;
function mountTable(tools: ToolDetail[]) {
  activeWrapper = mount(ServerDetailToolsTable, {
    props: { tools, kind: "rest", clientName: "acme" },
    global: { plugins: [makeRouter()] },
  });
  return activeWrapper;
}

afterEach(() => {
  activeWrapper?.unmount();
  activeWrapper = null;
  apiPatch.mockReset();
});

describe("ServerDetailToolsTable", () => {
  it("optimistically enables a disabled tool immediately on click, then reverts and shows a row error if the save fails", async () => {
    let rejectPatch: (err: unknown) => void = () => {};
    apiPatch.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectPatch = reject;
        }),
    );
    const wrapper = mountTable([makeTool({ enabled: false })]);

    const toggleBtn = wrapper.find("tbody tr .toggle");
    await toggleBtn.trigger("click");
    // Optimistic: flipped before the (still-pending) API call has settled at all.
    expect(toggleBtn.text()).toBe("Enabled");

    rejectPatch(new ApiError(500, "SERVER_ERROR", "Upstream unreachable."));
    await flushPromises();

    expect(toggleBtn.text()).toBe("Disabled");
    expect(wrapper.find(".row-error").text()).toBe("Upstream unreachable.");
  });

  it("optimistically marks a tool sensitive immediately on click, and keeps it set once the save succeeds", async () => {
    let resolvePatch: () => void = () => {};
    apiPatch.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolvePatch = resolve;
        }),
    );
    const wrapper = mountTable([makeTool({ sensitive: false })]);

    const sensitiveBtn = wrapper.find("tbody tr td:nth-child(5) button");
    await sensitiveBtn.trigger("click");
    // Optimistic: flipped before the (still-pending) API call has settled at all.
    expect(sensitiveBtn.text()).toBe("🔒 Sensitive");

    resolvePatch();
    await flushPromises();

    expect(sensitiveBtn.text()).toBe("🔒 Sensitive");
    expect(wrapper.find(".row-error").exists()).toBe(false);
    expect(apiPatch).toHaveBeenCalledWith("/admin-api/clients/acme/tools/search", { sensitive: true });
  });

  it("reverts an optimistic sensitivity change and reports the row error when the save fails", async () => {
    let rejectPatch: (err: unknown) => void = () => {};
    apiPatch.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectPatch = reject;
        }),
    );
    const wrapper = mountTable([makeTool({ sensitive: false })]);

    const sensitiveBtn = wrapper.find("tbody tr td:nth-child(5) button");
    await sensitiveBtn.trigger("click");
    expect(sensitiveBtn.text()).toBe("🔒 Sensitive");

    rejectPatch(new ApiError(400, "BAD_REQUEST", "Could not mark sensitive."));
    await flushPromises();

    expect(sensitiveBtn.text()).toBe("Mark sensitive");
    expect(wrapper.find(".row-error").text()).toBe("Could not mark sensitive.");
  });

  it("requires confirmation before unmarking a tool as sensitive, since that removes its step-up gate", async () => {
    const wrapper = mountTable([makeTool({ sensitive: true })]);

    const sensitiveBtn = wrapper.find("tbody tr td:nth-child(5) button");
    await sensitiveBtn.trigger("click");

    // No PATCH fires, and the flag stays put, until the dialog is confirmed.
    expect(apiPatch).not.toHaveBeenCalled();
    expect(wrapper.find('[role="alertdialog"]').exists()).toBe(true);
    expect(sensitiveBtn.text()).toBe("🔒 Sensitive");

    apiPatch.mockResolvedValueOnce(undefined);
    await wrapper.find('[role="alertdialog"] .btn-danger').trigger("click");
    await flushPromises();

    expect(apiPatch).toHaveBeenCalledWith("/admin-api/clients/acme/tools/search", { sensitive: false });
    expect(wrapper.find("tbody tr td:nth-child(5) button").text()).toBe("Mark sensitive");
  });

  it("marks a tool sensitive with no confirmation dialog (only the removal direction is gated)", async () => {
    apiPatch.mockResolvedValueOnce(undefined);
    const wrapper = mountTable([makeTool({ sensitive: false })]);

    await wrapper.find("tbody tr td:nth-child(5) button").trigger("click");

    expect(wrapper.find('[role="alertdialog"]').exists()).toBe(false);
    expect(apiPatch).toHaveBeenCalledWith("/admin-api/clients/acme/tools/search", { sensitive: true });
  });
});
