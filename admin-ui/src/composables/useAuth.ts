import { reactive, readonly } from "vue";
import { api, ApiError } from "./useApi";
import type { CurrentUser } from "@/types/api";

interface AuthState {
  loading: boolean;
  checked: boolean;
  user: NonNullable<CurrentUser["user"]> | null;
  authMethod: CurrentUser["auth_method"] | null;
}

const state = reactive<AuthState>({ loading: false, checked: false, user: null, authMethod: null });

/**
 * True for a super-admin session (admin role, no team) — mirrors the backend's
 * isSuperAdminCaller (src/middleware/authz.ts), which is the actual enforcement
 * point. This is a UI-only mirror for gating affordances the caller would
 * otherwise just get a 403 from (e.g. setting an mcp_api_keys row's adminRole);
 * it grants no access on its own. `team_id` absent (e.g. a bearer-style demo
 * user) is treated as super-admin, same as the backend's `?? null` default.
 */
export function isSuperAdminUser(user: AuthState["user"]): boolean {
  return user !== null && user.role === "admin" && (user.team_id ?? null) === null;
}

export function useAuth() {
  async function checkSession(): Promise<boolean> {
    state.loading = true;
    try {
      const me = await api.get<CurrentUser>("/admin-api/auth/me");
      state.user = me.user ?? null;
      state.authMethod = me.auth_method;
      return state.user !== null;
    } catch (err) {
      state.user = null;
      state.authMethod = null;
      if (!(err instanceof ApiError) || err.status !== 401) throw err;
      return false;
    } finally {
      state.loading = false;
      state.checked = true;
    }
  }

  async function login(username: string, password: string): Promise<void> {
    const res = await api.post<{ user: NonNullable<CurrentUser["user"]>; csrf_token: string }>(
      "/admin-api/auth/login",
      {
        username,
        password,
      },
    );
    state.user = res.user;
    state.authMethod = "session";
    state.checked = true;
  }

  async function logout(): Promise<void> {
    try {
      await api.post("/admin-api/auth/logout");
    } finally {
      state.user = null;
      state.authMethod = null;
    }
  }

  return { state: readonly(state), checkSession, login, logout };
}
