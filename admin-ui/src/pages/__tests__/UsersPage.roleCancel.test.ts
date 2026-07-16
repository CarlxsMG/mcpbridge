// Guard coverage for finding #23: the role SelectMenu is controlled by
// `:model-value="user.role"` and its @update handler only opens a ConfirmDialog
// (it never mutates user.role). If the confirm is cancelled, nothing reloads, so
// the dropdown must still display the user's true role — never the un-applied
// pick. The `:key="user.role"` binding keeps the control pinned to the source of
// truth. This test locks that end-state.
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, flushPromises, type VueWrapper } from "@vue/test-utils";
import UsersPage from "../UsersPage.vue";
import type { AdminUserSummary } from "@/types/api";

const apiGet = vi.fn();
const apiPatch = vi.fn();

vi.mock("@/composables/useApi", () => ({
  api: {
    get: (path: string) => apiGet(path),
    patch: (path: string, body?: unknown) => apiPatch(path, body),
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
}));

function makeUser(overrides: Partial<AdminUserSummary> = {}): AdminUserSummary {
  return {
    username: "alice",
    role: "viewer",
    team_id: null,
    is_active: true,
    last_login_at: null,
    ...overrides,
  } as AdminUserSummary;
}

let activeWrapper: VueWrapper | null = null;
async function mountUsers(users: AdminUserSummary[]) {
  apiGet.mockImplementation((path: string) => {
    if (path === "/admin-api/users") return Promise.resolve({ users });
    if (path === "/admin-api/teams") return Promise.resolve({ items: [] });
    return Promise.reject(new Error(`unexpected GET ${path}`));
  });
  activeWrapper = mount(UsersPage, {
    attachTo: document.body,
    global: { stubs: { RouterLink: true } },
  });
  await flushPromises();
  return activeWrapper;
}

afterEach(() => {
  activeWrapper?.unmount();
  activeWrapper = null;
  apiGet.mockReset();
  apiPatch.mockReset();
});

describe("UsersPage — role select reflects source of truth on cancel", () => {
  it("still shows the original role after picking a different one and cancelling", async () => {
    const wrapper = await mountUsers([makeUser({ role: "viewer" })]);

    // The role SelectMenu is the first select trigger in the row.
    const roleTrigger = wrapper.findAll(".select-menu-trigger")[0];
    expect(roleTrigger.find(".select-menu-value").text()).toBe("Viewer");

    // Open and pick a different role ("Operator").
    await roleTrigger.trigger("click");
    const operatorOption = Array.from(document.querySelectorAll<HTMLElement>(".select-menu-option")).find(
      (el) => el.textContent?.trim() === "Operator",
    );
    expect(operatorOption).toBeDefined();
    operatorOption?.click();
    await flushPromises();

    // A confirm dialog opened; the change was NOT applied yet.
    expect(wrapper.find('[role="alertdialog"]').exists()).toBe(true);
    expect(apiPatch).not.toHaveBeenCalled();

    // Cancel it.
    await wrapper.find('[role="alertdialog"] .btn-secondary').trigger("click");
    await flushPromises();

    // The dropdown must display the true, unchanged role — not the un-applied pick.
    expect(apiPatch).not.toHaveBeenCalled();
    expect(wrapper.findAll(".select-menu-trigger")[0].find(".select-menu-value").text()).toBe("Viewer");
  });
});
