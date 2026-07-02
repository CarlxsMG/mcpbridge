<script setup lang="ts">
import { ref, onMounted } from "vue";
import { api, ApiError } from "../composables/useApi";
import type { BundleSummary, BundleDetail, BundleToolRef } from "../types/api";
import BundleToolPicker from "../components/BundleToolPicker.vue";
import { Boxes } from "lucide-vue-next";

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
      <button type="button" :class="showCreateForm ? 'btn-secondary' : 'btn-primary'" @click="showCreateForm = !showCreateForm">
        {{ showCreateForm ? "Cancel" : "Create bundle" }}
      </button>
    </header>

    <form v-if="showCreateForm" class="create-form" @submit.prevent="createBundle">
      <div class="field">
        <label for="new-bundle-name">Name</label>
        <input id="new-bundle-name" v-model="newName" type="text" placeholder="e.g. assistant-a" required />
      </div>
      <p v-if="createError" class="error">{{ createError }}</p>
      <div class="field">
        <label for="new-bundle-description">Description (optional)</label>
        <input id="new-bundle-description" v-model="newDescription" type="text" placeholder="What this bundle is for" />
      </div>
      <div class="field">
        <label>Tools</label>
        <BundleToolPicker v-model="newTools" />
      </div>
      <button type="submit" class="btn-primary" :disabled="creating">{{ creating ? "Creating…" : "Create bundle" }}</button>
    </form>

    <p v-if="errorMessage" class="error" role="alert">{{ errorMessage }}</p>
    <div v-if="loading" class="loading">Loading…</div>

    <template v-else-if="items.length === 0">
      <div class="empty-state">
        <Boxes :size="26" stroke-width="1.5" aria-hidden="true" class="empty-icon" />
        <p>No bundles yet. A bundle lets you hand an MCP client a curated, cross-client tool selection instead of one client's full tool list.</p>
      </div>
    </template>

    <div v-else class="table-card table-scroll">
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
            <td class="desc-cell" :title="bundle.description || undefined">{{ bundle.description || "—" }}</td>
            <td>{{ bundle.toolsCount }}</td>
            <td>
              <button
                type="button"
                class="toggle"
                :class="bundle.enabled ? 'toggle-on' : 'toggle-off'"
                :aria-pressed="bundle.enabled"
                @click="toggleEnabled(bundle)"
              >
                {{ bundle.enabled ? "Disable bundle" : "Enable bundle" }}
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
  color: var(--text-secondary);
  margin: 0;
  max-width: 520px;
}
.create-form {
  background: var(--surface-sunken);
  padding: 1.25rem;
  border-radius: var(--radius-md);
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
  margin-bottom: 0.3rem;
}
.field input {
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
.bundles-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.9rem;
}
.bundles-table th {
  text-align: left;
  padding: 0.65rem 0.85rem;
  border-bottom: 1px solid var(--border);
  color: var(--text-muted);
  font-size: 0.74rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.bundles-table td {
  padding: 0.6rem 0.85rem;
  border-bottom: 1px solid var(--border);
  vertical-align: middle;
}
.bundles-table tbody tr:last-child td {
  border-bottom: none;
}
.bundles-table tbody tr:hover {
  background: var(--surface-sunken);
}
.desc-cell {
  color: var(--text-secondary);
  max-width: 320px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.toggle {
  display: inline-flex;
  align-items: center;
  gap: 0.45em;
  border-radius: var(--radius-pill);
  padding: 0.28rem 0.8rem;
  font-size: 0.78rem;
  font-weight: 600;
  cursor: pointer;
  background: var(--surface);
  transition: background-color 0.12s ease;
}
.toggle::before {
  content: "";
  width: 0.55em;
  height: 0.55em;
  border-radius: 50%;
  background: currentColor;
  flex-shrink: 0;
}
.toggle-on {
  border: 1px solid var(--ok);
  color: var(--ok);
}
.toggle-off {
  border: 1px solid var(--border-strong);
  color: var(--text-secondary);
}
.toggle-on:hover {
  background: var(--ok-soft);
}
.toggle-off:hover {
  background: var(--surface-sunken);
}
.row-error {
  color: var(--breach);
  font-size: 0.75rem;
  margin: 0.25rem 0 0;
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
.loading {
  color: var(--text-muted);
  padding: 1rem 0;
}
.error {
  color: var(--breach);
}
</style>
