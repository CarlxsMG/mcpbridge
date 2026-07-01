<script setup lang="ts">
import { ref, onMounted } from "vue";
import { api, ApiError } from "../composables/useApi";
import type { BundleSummary, BundleDetail, BundleToolRef } from "../types/api";
import BundleToolPicker from "../components/BundleToolPicker.vue";

const items = ref<BundleSummary[]>([]);
const loading = ref(false);
const errorMessage = ref("");
const rowError = ref<Record<string, string>>({});

const showCreateForm = ref(false);
const newName = ref("");
const newDescription = ref("");
const newTools = ref<BundleToolRef[]>([]);
const createError = ref("");
const creating = ref(false);

async function load() {
  loading.value = true;
  errorMessage.value = "";
  try {
    const res = await api.get<{ items: BundleSummary[] }>("/admin-api/bundles");
    items.value = res.items;
  } catch (err) {
    errorMessage.value = err instanceof ApiError ? err.message : "Failed to load bundles.";
  } finally {
    loading.value = false;
  }
}
onMounted(load);

async function createBundle() {
  createError.value = "";
  if (!newName.value.trim()) {
    createError.value = "Name is required.";
    return;
  }
  creating.value = true;
  try {
    await api.post<BundleDetail>("/admin-api/bundles", {
      name: newName.value.trim(),
      description: newDescription.value.trim() || undefined,
      tools: newTools.value,
    });
    newName.value = "";
    newDescription.value = "";
    newTools.value = [];
    showCreateForm.value = false;
    await load();
  } catch (err) {
    createError.value = err instanceof ApiError ? err.message : "Failed to create bundle.";
  } finally {
    creating.value = false;
  }
}

async function toggleEnabled(bundle: BundleSummary) {
  const next = !bundle.enabled;
  const previous = bundle.enabled;
  bundle.enabled = next; // optimistic
  delete rowError.value[bundle.name];
  try {
    await api.patch(`/admin-api/bundles/${encodeURIComponent(bundle.name)}`, { enabled: next });
  } catch (err) {
    bundle.enabled = previous; // revert on failure
    rowError.value[bundle.name] = err instanceof ApiError ? err.message : "Failed to update.";
  }
}
</script>

<template>
  <section>
    <header class="page-header">
      <div>
        <h1>Bundles</h1>
        <p class="subtitle">Cross-client tool selections, each served at its own <code>/mcp-custom/&lt;name&gt;</code> endpoint.</p>
      </div>
      <button type="button" class="btn-primary" @click="showCreateForm = !showCreateForm">
        {{ showCreateForm ? "Cancel" : "Create bundle" }}
      </button>
    </header>

    <form v-if="showCreateForm" class="create-form" @submit.prevent="createBundle">
      <div class="field">
        <label for="new-bundle-name">Name</label>
        <input id="new-bundle-name" v-model="newName" type="text" placeholder="e.g. assistant-a" required />
      </div>
      <div class="field">
        <label for="new-bundle-description">Description (optional)</label>
        <input id="new-bundle-description" v-model="newDescription" type="text" placeholder="What this bundle is for" />
      </div>
      <div class="field">
        <label>Tools</label>
        <BundleToolPicker v-model="newTools" />
      </div>
      <p v-if="createError" class="error">{{ createError }}</p>
      <button type="submit" class="btn-primary" :disabled="creating">{{ creating ? "Creating…" : "Create bundle" }}</button>
    </form>

    <p v-if="errorMessage" class="error" role="alert">{{ errorMessage }}</p>
    <div v-if="loading" class="loading">Loading…</div>

    <template v-else-if="items.length === 0">
      <div class="empty-state">
        <p>No bundles yet. A bundle lets you hand an MCP client a curated, cross-client tool selection instead of one client's full tool list.</p>
      </div>
    </template>

    <div v-else class="table-scroll">
      <table class="bundles-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Description</th>
            <th>Tools</th>
            <th>Enabled</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="bundle in items" :key="bundle.name">
            <td>
              <RouterLink :to="`/bundles/${encodeURIComponent(bundle.name)}`">{{ bundle.name }}</RouterLink>
            </td>
            <td class="desc-cell">{{ bundle.description || "—" }}</td>
            <td>{{ bundle.toolsCount }}</td>
            <td>
              <button
                type="button"
                class="toggle"
                :class="bundle.enabled ? 'toggle-on' : 'toggle-off'"
                :aria-pressed="bundle.enabled"
                @click="toggleEnabled(bundle)"
              >
                {{ bundle.enabled ? "Enabled" : "Disabled" }}
              </button>
              <p v-if="rowError[bundle.name]" class="row-error">{{ rowError[bundle.name] }}</p>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
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
.subtitle {
  color: #63676e;
  margin: 0;
  max-width: 520px;
}
.create-form {
  background: #fafbfc;
  padding: 1.25rem;
  border-radius: 8px;
  margin-bottom: 1.5rem;
  max-width: 480px;
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
.field input {
  width: 100%;
  padding: 0.45rem 0.6rem;
  border: 1px solid #cfd4da;
  border-radius: 6px;
  box-sizing: border-box;
}
.bundles-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.9rem;
}
.bundles-table th {
  text-align: left;
  padding: 0.5rem 0.75rem;
  border-bottom: 2px solid #e5e7eb;
  color: #52565c;
  font-size: 0.8rem;
  text-transform: uppercase;
  letter-spacing: 0.02em;
}
.bundles-table td {
  padding: 0.6rem 0.75rem;
  border-bottom: 1px solid #eef0f2;
  vertical-align: middle;
}
.desc-cell {
  color: #63676e;
  max-width: 320px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.toggle {
  display: inline-flex;
  align-items: center;
  gap: 0.4em;
  border-radius: 6px;
  padding: 0.25rem 0.75rem;
  font-size: 0.8rem;
  font-weight: 600;
  cursor: pointer;
  background: #fff;
}
.toggle::before {
  content: "";
  width: 0.6em;
  height: 0.6em;
  border-radius: 50%;
  background: currentColor;
}
.toggle-on {
  border: 1px solid #146c2e;
  color: #146c2e;
}
.toggle-off {
  border: 1px solid #9aa0a8;
  color: #52565c;
}
.row-error {
  color: #a11212;
  font-size: 0.75rem;
  margin: 0.25rem 0 0;
}
.empty-state {
  padding: 2rem;
  text-align: center;
  color: #63676e;
  background: #fafbfc;
  border-radius: 8px;
}
.loading {
  color: #63676e;
  padding: 1rem 0;
}
.error {
  color: #a11212;
}
</style>
