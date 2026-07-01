<script setup lang="ts">
import { ref, onMounted } from "vue";
import { api, ApiError } from "../composables/useApi";
import { useAuth } from "../composables/useAuth";
import type { AdminUserSummary, AdminRole } from "../types/api";
import ConfirmDialog from "../components/ConfirmDialog.vue";

const { state: authState } = useAuth();

const users = ref<AdminUserSummary[]>([]);
const loading = ref(false);
const errorMessage = ref("");
const pendingDelete = ref<AdminUserSummary | null>(null);

const showCreateForm = ref(false);
const newUsername = ref("");
const newPassword = ref("");
const newRole = ref<AdminRole>("admin");
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
    newRole.value = "admin";
    showCreateForm.value = false;
    await load();
  } catch (err) {
    createError.value = err instanceof ApiError ? err.message : "Failed to create user.";
  } finally {
    creating.value = false;
  }
}

async function toggleRole(user: AdminUserSummary) {
  const nextRole: AdminRole = user.role === "admin" ? "viewer" : "admin";
  try {
    await api.patch(`/admin-api/users/${encodeURIComponent(user.username)}`, { role: nextRole });
    await load();
  } catch (err) {
    errorMessage.value = err instanceof ApiError ? err.message : "Failed to update role.";
  }
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
      <button type="button" class="btn-primary" @click="showCreateForm = !showCreateForm">
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
          <option value="viewer">Viewer</option>
        </select>
      </div>
      <p v-if="createError" class="error">{{ createError }}</p>
      <button type="submit" class="btn-primary" :disabled="creating">{{ creating ? "Creating…" : "Create user" }}</button>
    </form>

    <p v-if="errorMessage" class="error" role="alert">{{ errorMessage }}</p>
    <div v-if="loading" class="loading">Loading…</div>

    <table v-else class="users-table">
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
            <button type="button" class="link-btn" @click="toggleRole(user)">
              {{ user.role }} <span class="switch-hint">(switch to {{ user.role === "admin" ? "viewer" : "admin" }})</span>
            </button>
          </td>
          <td>{{ user.is_active ? "Yes" : "No" }}</td>
          <td>{{ user.last_login_at ? new Date(user.last_login_at).toLocaleString() : "Never" }}</td>
          <td>
            <button type="button" class="link-btn danger" @click="requestDelete(user)">Delete</button>
          </td>
        </tr>
      </tbody>
    </table>

    <ConfirmDialog
      :open="pendingDelete !== null"
      title="Delete this user?"
      :message="pendingDelete ? `'${pendingDelete.username}' will lose access immediately and all their sessions will be revoked.` : ''"
      :confirm-label="pendingDelete ? `Delete ${pendingDelete.username}` : 'Delete'"
      danger
      @confirm="confirmDelete"
      @cancel="pendingDelete = null"
    />
  </section>
</template>

<style scoped>
.page-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 1.25rem;
}
.create-form {
  background: #fafbfc;
  padding: 1.25rem;
  border-radius: 8px;
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
  margin-bottom: 0.25rem;
}
.field input,
.field select {
  width: 100%;
  padding: 0.45rem 0.6rem;
  border: 1px solid #cfd4da;
  border-radius: 6px;
  box-sizing: border-box;
}
.users-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.9rem;
}
.users-table th {
  text-align: left;
  padding: 0.5rem 0.75rem;
  border-bottom: 2px solid #e5e7eb;
  color: #52565c;
  font-size: 0.78rem;
  text-transform: uppercase;
}
.users-table td {
  padding: 0.55rem 0.75rem;
  border-bottom: 1px solid #eef0f2;
}
.you-tag {
  color: #63676e;
  font-size: 0.8rem;
}
.switch-hint {
  color: #63676e;
  font-weight: 400;
  font-size: 0.78rem;
}
.link-btn.danger {
  color: #a11212;
}
.error {
  color: #a11212;
}
.loading {
  color: #63676e;
}
</style>
