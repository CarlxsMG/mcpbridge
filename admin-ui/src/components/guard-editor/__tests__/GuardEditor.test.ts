// GuardEditor.vue statically imports its 11 extracted GuardEditorXxx.vue section
// components. Stubbing them out by their own resolvable file path (rather than
// mounting the real thing) keeps this file scoped to GuardEditor.vue's own
// rate-limit/timeout validation and clear-guards confirm flow.
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, flushPromises, type VueWrapper } from "@vue/test-utils";
import GuardEditor from "../GuardEditor.vue";

vi.mock("../GuardEditorTags.vue", () => ({ default: { template: "<div />" } }));
vi.mock("../GuardEditorRedaction.vue", () => ({ default: { template: "<div />" } }));
vi.mock("../GuardEditorGuardrails.vue", () => ({ default: { template: "<div />" } }));
vi.mock("../GuardEditorApproval.vue", () => ({ default: { template: "<div />" } }));
vi.mock("../GuardEditorQuarantine.vue", () => ({ default: { template: "<div />" } }));
vi.mock("../GuardEditorWebSocket.vue", () => ({ default: { template: "<div />" } }));
vi.mock("../GuardEditorGraphql.vue", () => ({ default: { template: "<div />" } }));
vi.mock("../GuardEditorCoalesce.vue", () => ({ default: { template: "<div />" } }));
vi.mock("../GuardEditorContextBudget.vue", () => ({ default: { template: "<div />" } }));

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

let activeWrapper: VueWrapper | null = null;
function mountEditor(props: Record<string, unknown> = {}) {
  activeWrapper = mount(GuardEditor, { props: { clientName: "acme", toolName: "search", ...props } });
  return activeWrapper;
}

function submitButton(wrapper: VueWrapper) {
  return wrapper.find('button[type="submit"]').element as HTMLButtonElement;
}

afterEach(() => {
  activeWrapper?.unmount();
  activeWrapper = null;
  apiPatch.mockReset();
});

describe("GuardEditor", () => {
  it("flags a non-positive rate limit as invalid and disables Save", async () => {
    const wrapper = mountEditor();

    const rateLimitInput = wrapper.find("#rate-limit");
    await rateLimitInput.setValue("0");
    await rateLimitInput.trigger("blur");

    expect(wrapper.find(".field-error").text()).toBe("Must be a positive number");
    expect(submitButton(wrapper).disabled).toBe(true);
  });

  it("flags a non-positive timeout as invalid and disables Save", async () => {
    const wrapper = mountEditor();

    const timeoutInput = wrapper.find("#timeout");
    await timeoutInput.setValue("-100");
    await timeoutInput.trigger("blur");

    expect(wrapper.find(".field-error").text()).toBe("Must be a positive number");
    expect(submitButton(wrapper).disabled).toBe(true);
  });

  it("re-enables Save once an invalid rate limit is corrected to a positive number", async () => {
    const wrapper = mountEditor();
    const rateLimitInput = wrapper.find("#rate-limit");
    await rateLimitInput.setValue("0");
    await rateLimitInput.trigger("blur");
    expect(submitButton(wrapper).disabled).toBe(true);

    await rateLimitInput.setValue("60");

    expect(wrapper.find(".field-error").exists()).toBe(false);
    expect(submitButton(wrapper).disabled).toBe(false);
  });

  it("clears guards immediately with no confirmation when there is nothing to lose", async () => {
    apiPatch.mockResolvedValueOnce(undefined);
    const wrapper = mountEditor({ guards: undefined });

    await wrapper.find(".actions .btn-secondary").trigger("click");
    await flushPromises();

    expect(wrapper.find('[role="alertdialog"]').exists()).toBe(false);
    expect(apiPatch).toHaveBeenCalledWith("/admin-api/clients/acme/tools/search", { guards: null });
  });

  it("asks for confirmation before clearing existing guards, then clears on confirm", async () => {
    apiPatch.mockResolvedValueOnce(undefined);
    const wrapper = mountEditor({ guards: { rateLimitPerMin: 60 } });

    await wrapper.find(".actions .btn-secondary").trigger("click");
    expect(wrapper.find('[role="alertdialog"]').exists()).toBe(true);
    expect(apiPatch).not.toHaveBeenCalled();

    await wrapper.find('[role="alertdialog"] .btn-danger').trigger("click");
    await flushPromises();

    expect(wrapper.find('[role="alertdialog"]').exists()).toBe(false);
    expect(apiPatch).toHaveBeenCalledWith("/admin-api/clients/acme/tools/search", { guards: null });
  });

  it("leaves the guards untouched when the clear confirmation is cancelled", async () => {
    const wrapper = mountEditor({ guards: { rateLimitPerMin: 60 } });

    await wrapper.find(".actions .btn-secondary").trigger("click");
    await wrapper.find('[role="alertdialog"] .btn-secondary').trigger("click");

    expect(wrapper.find('[role="alertdialog"]').exists()).toBe(false);
    expect(apiPatch).not.toHaveBeenCalled();
  });

  it("PATCHes the assembled rate-limit + timeout guards on submit and emits toolChanged", async () => {
    apiPatch.mockResolvedValueOnce(undefined);
    const wrapper = mountEditor();

    await wrapper.find("#rate-limit").setValue("60");
    await wrapper.find("#timeout").setValue("5000");
    await wrapper.find("form.guard-editor").trigger("submit");
    await flushPromises();

    expect(apiPatch).toHaveBeenCalledWith("/admin-api/clients/acme/tools/search", {
      guards: { rateLimitPerMin: 60, timeoutMs: 5000 },
    });
    expect(wrapper.emitted("toolChanged")).toHaveLength(1);
  });

  it("omits rate-limit and timeout from the payload when both fields are left blank", async () => {
    apiPatch.mockResolvedValueOnce(undefined);
    const wrapper = mountEditor();

    await wrapper.find("form.guard-editor").trigger("submit");
    await flushPromises();

    expect(apiPatch).toHaveBeenCalledWith("/admin-api/clients/acme/tools/search", { guards: {} });
    expect(wrapper.emitted("toolChanged")).toHaveLength(1);
  });
});
