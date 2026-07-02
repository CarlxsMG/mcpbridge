<script setup lang="ts">
import { ref, computed, onMounted } from "vue";
import { api, ApiError } from "../composables/useApi";
import { useAuth } from "../composables/useAuth";
import type { AdminUserSummary, AdminRole } from "../types/api";
import ConfirmDialog from "../components/ConfirmDialog.vue";
import { UserCog } from "lucide-vue-next";

const { state: authState } = useAuth();

const users = ref<AdminUserSummary[]>([]);
const loading = ref(false);
const errorMessage = ref("");
const pendingDelete = ref<AdminUserSummary | null>(null);
const pendingRoleChange = ref<{ user: AdminUserSummary; nextRole: string } | null>(null);

const activeAdminCount = computed(() => users.value.filter((u) => u.role === "admin" && u.is_active).length);

// Mirrors the backend's LAST_ADMIN_PROTECTED guard so the control is disabled
// up front instead of letting the operator hit a guaranteed-to-fail request.
function isLastActiveAdmin(user: AdminUserSummary): boolean {
  return user.role === "admin" && user.is_active && activeAdminCount.value <= 1;
}

const showCreateForm = ref(false);
const newUsername = ref("");
const newPassword = ref("");
const newRole = ref<AdminRole>("viewer");
const createError = ref("");
const creating = ref(false);

async function load() {
  loading.value = true;
  errorMessage.value = "";
  try {
    const res = await api.get<{ users: AdminUserSummary[] }>("/admin-api/users");
    users.value = res.users;
  } catch (err) {
    errorMessage.value = err instanceof ApiError ? err.message : "Failed to load users.";
  } finally {
    loading.value = false;
  }
}

onMounted(load);

async function createUser() {
  createError.value = "";
  if (newPassword.value.length < 12) {
    createError.value = "Password must be at least 12 characters.";
    return;
  }
  creating.value = true;
  try {
    await api.post("/admin-api/users", { username: newUsername.value.trim(), password: newPassword.value, role: newRole.value });
    newUsername.value = "";
    newPassword.value = "";
    newRole.value = "viewer";
    showCreateForm.value = false;
    await load();
  } catch (err) {
    createError.value = err instanceof ApiError ? err.message : "Failed to create user.";
  } finally {
    creating.value = false;
  }
}

async function changeRole(user: AdminUserSummary, nextRole: string) {
  try {
    await api.patch(`/admin-api/users/${encodeURIComponent(user.username)}`, { role: nextRole });
    await load();
  } catch (err) {
    errorMessage.value = err instanceof ApiError ? err.message : "Failed to update role.";
    await load(); // reset the select back to the persisted value
  }
}

function requestRoleChange(user: AdminUserSummary, nextRole: string) {
  if (nextRole === user.role) return;
  pendingRoleChange.value = { user, nextRole };
}

function roleChangeMessage(user: AdminUserSummary, nextRole: string): string {
  if (user.username === authState.user?.username) {
    return `You are changing your own role from '${user.role}' to '${nextRole}'. This may immediately restrict what you can do in this admin panel.`;
  }
  return `Change '${user.username}''s role from '${user.role}' to '${nextRole}'?`;
}

async function confirmRoleChange() {
  if (!pendingRoleChange.value) return;
  const { user, nextRole } = pendingRoleChange.value;
  pendingRoleChange.value = null;
  await changeRole(user, nextRole);
}

function requestDelete(user: AdminUserSummary) {
  pendingDelete.value = user;
}

async function confirmDelete() {
  if (!pendingDelete.value) return;
  const user = pendingDelete.value;
  pendingDelete.value = null;
  try {
    await api.delete(`/admin-api/users/${encodeURIComponent(user.username)}`);
    await load();
  } catch (err) {
    errorMessage.value = err instanceof ApiError ? err.message : "Failed to delete user.";
  }
}
</script>

<template>
  <section>
    <header class="page-header">
      <h1>Users</h1>
      <button type="button" :class="showCreateForm ? 'btn-secondary' : 'btn-primary'" @click="showCreateForm = !showCreateForm">
        {{ showCreateForm ? "Cancel" : "Add user" }}
      </button>
    </header>

    <form v-if="showCreateForm" class="create-form" @submit.prevent="createUser">
      <div class="field">
        <label for="new-username">Username</label>
        <input id="new-username" v-model="newUsername" type="text" required />
      </div>
      <div class="field">
        <label for="new-password">Password (min 12 chars)</label>
        <input id="new-password" v-model="newPassword" type="password" required minlength="12" />
      </div>
      <div class="field">
        <label for="new-role">Role</label>
        <select id="new-role" v-model="newRole">
          <option value="admin">Admin</option>
          <option value="operator">Operator</option>
          <option value="auditor">Auditor</option>
          <option value="viewer">Viewer</option>
        </select>
      </div>
      <p v-if="createError" class="error">{{ createError }}</p>
      <button type="submit" class="btn-primary" :disabled="creating">{{ creating ? "Creating…" : "Create user" }}</button>
    </form>

    <p v-if="errorMessage" class="error" role="alert">{{ errorMessage }}</p>
    <div v-if="loading" class="loading">Loading…</div>

    <div v-else-if="users.length === 0" class="empty-state">
      <UserCog :size="26" stroke-width="1.5" aria-hidden="true" class="empty-icon" />
      <p>No admin users yet.</p>
    </div>

    <div v-else class="table-card table-scroll">
    <table class="users-table">
      <thead>
        <tr>
          <th>Username</th>
          <th>Role</th>
          <th>Active</th>
          <th>Last login</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="user in users" :key="user.username">
          <td>{{ user.username }} <span v-if="user.username === authState.user?.username" class="you-tag">(you)</span></td>
          <td>
            <select
              class="role-select"
              :value="user.role"
              :disabled="isLastActiveAdmin(user)"
              :title="isLastActiveAdmin(user) ? 'Cannot change the last active admin — promote another user first.' : ''"
              @change="requestRoleChange(user, ($event.target as HTMLSelectElement).value)"
            >
              <option value="admin">admin</option>
              <option value="operator">operator</option>
              <option value="auditor">auditor</option>
              <option value="viewer">viewer</option>
            </select>
            <span v-if="isLastActiveAdmin(user)" class="switch-hint">Cannot change the last active admin — promote another user first.</span>
          </td>
          <td>{{ user.is_active ? "Yes" : "No" }}</td>
          <td>{{ user.last_login_at ? new Date(user.last_login_at).toLocaleString() : "Never" }}</td>
          <td>
            <button
              type="button"
              class="link-btn danger"
              :disabled="isLastActiveAdmin(user)"
              :title="isLastActiveAdmin(user) ? 'Cannot delete the last active admin — promote another user first.' : ''"
              @click="requestDelete(user)"
            >
              Delete
            </button>
            <span v-if="isLastActiveAdmin(user)" class="switch-hint">Cannot delete the last active admin — promote another user first.</span>
          </td>
        </tr>
      </tbody>
    </table>
    </div>

    <ConfirmDialog
      :open="pendingDelete !== null"
      title="Delete this user?"
      :message="pendingDelete ? `'${pendingDelete.username}' will lose access immediately and all their sessions will be revoked.` : ''"
      :confirm-label="pendingDelete ? `Delete ${pendingDelete.username}` : 'Delete'"
      danger
      @confirm="confirmDelete"
      @cancel="pendingDelete = null"
    />

    <ConfirmDialog
      :open="pendingRoleChange !== null"
      title="Change this user's role?"
      :message="pendingRoleChange ? roleChangeMessage(pendingRoleChange.user, pendingRoleChange.nextRole) : ''"
      :confirm-label="pendingRoleChange ? `Change to ${pendingRoleChange.nextRole}` : 'Change role'"
      @confirm="confirmRoleChange"
      @cancel="pendingRoleChange = null"
    />
  </section>
</template>

<style scoped>
.page-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  margin-bottom: 1.25rem;
}
.page-header h1 {
  margin: 0 0 0.2rem;
}
.create-form {
  background: var(--surface-sunken);
  padding: 1.25rem;
  border-radius: var(--radius-md);
  margin-bottom: 1.5rem;
  max-width: 380px;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}
.field label {
  display: block;
  font-size: 0.85rem;
  font-weight: 600;
  margin-bottom: 0.3rem;
}
.field input,
.field select {
  width: 100%;
  padding: 0.55rem 0.7rem;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  font-size: 0.9rem;
  font-family: var(--font-body);
  box-sizing: border-box;
}
.table-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-xs);
}
.users-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.9rem;
}
.users-table th {
  text-align: left;
  padding: 0.65rem 0.85rem;
  border-bottom: 1px solid var(--border);
  color: var(--text-muted);
  font-size: 0.74rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.users-table td {
  padding: 0.6rem 0.85rem;
  border-bottom: 1px solid var(--border);
  vertical-align: middle;
}
.users-table tbody tr:last-child td {
  border-bottom: none;
}
.users-table tbody tr:hover {
  background: var(--surface-sunken);
}
.you-tag {
  color: var(--text-muted);
  font-size: 0.8rem;
}
.switch-hint {
  color: var(--text-muted);
  font-weight: 400;
  font-size: 0.78rem;
}
.link-btn.danger {
  color: var(--breach);
}
.empty-state {
  padding: 3rem 2rem;
  text-align: center;
  color: var(--text-secondary);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
}
.empty-icon {
  color: var(--text-muted);
  margin-bottom: 0.75rem;
}
.error {
  color: var(--breach);
}
.loading {
  color: var(--text-muted);
}
</style>
