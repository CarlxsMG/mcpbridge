// Regression coverage for the "Approve fires with no confirmation" safety bug
// (fixed in commit d710cf9): Approve must gate on ConfirmDialog exactly like
// Reject does, never call the API on the raw click.
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, flushPromises, type VueWrapper } from "@vue/test-utils";
import ApprovalsPage from "../ApprovalsPage.vue";
import type { ApprovalRecord } from "@/types/api";

const apiGet = vi.fn();
const apiPost = vi.fn();

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

function makeApproval(overrides: Partial<ApprovalRecord> = {}): ApprovalRecord {
  return {
    id: 42,
    clientName: "acme",
    toolName: "delete_user",
    argsHash: "hash",
    argsJson: "{}",
    status: "pending",
    createdAt: Date.now(),
    decidedAt: null,
    decidedBy: null,
    note: null,
    consumedAt: null,
    requestedBy: null,
    requiredLevels: 1,
    decisions: [],
    ...overrides,
  };
}

let activeWrapper: VueWrapper | null = null;
async function mountApprovals(items: ApprovalRecord[]) {
  apiGet.mockResolvedValue({ items });
  activeWrapper = mount(ApprovalsPage);
  await flushPromises();
  return activeWrapper;
}

afterEach(() => {
  activeWrapper?.unmount();
  activeWrapper = null;
  apiGet.mockReset();
  apiPost.mockReset();
});

describe("ApprovalsPage", () => {
  it("opens a confirmation dialog on Approve and does not call the API until confirmed", async () => {
    const wrapper = await mountApprovals([makeApproval()]);

    await wrapper.find("tbody .link-btn:not(.danger)").trigger("click");

    expect(wrapper.find('[role="alertdialog"]').exists()).toBe(true);
    expect(apiPost).not.toHaveBeenCalled();

    apiPost.mockResolvedValueOnce(undefined);
    await wrapper.find('[role="alertdialog"] .btn-danger').trigger("click");
    await flushPromises();

    expect(apiPost).toHaveBeenCalledWith("/admin-api/approvals/42/approve", undefined);
  });

  it("does not call the API when the Approve confirmation is cancelled", async () => {
    const wrapper = await mountApprovals([makeApproval()]);

    await wrapper.find("tbody .link-btn:not(.danger)").trigger("click");
    await wrapper.find('[role="alertdialog"] .btn-secondary').trigger("click");

    expect(wrapper.find('[role="alertdialog"]').exists()).toBe(false);
    expect(apiPost).not.toHaveBeenCalled();
  });

  it("also gates Reject behind confirmation, matching the Approve fix", async () => {
    const wrapper = await mountApprovals([makeApproval()]);

    await wrapper.find("tbody .link-btn.danger").trigger("click");

    expect(wrapper.find('[role="alertdialog"]').exists()).toBe(true);
    expect(apiPost).not.toHaveBeenCalled();

    apiPost.mockResolvedValueOnce(undefined);
    await wrapper.find('[role="alertdialog"] .btn-danger').trigger("click");
    await flushPromises();

    expect(apiPost).toHaveBeenCalledWith("/admin-api/approvals/42/reject", undefined);
  });
});
