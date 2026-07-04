<script setup lang="ts">
import { ref, onMounted } from "vue";
import { api, ApiError } from "../composables/useApi";
import { useResource } from "../composables/useResource";
import { useOptimisticToggle } from "../composables/useOptimisticToggle";
import type { BundleSummary, BundleDetail, BundleToolRef } from "../types/api";
import BundleToolPicker from "../components/BundleToolPicker.vue";
import SignalLoader from "../components/SignalLoader.vue";
import TableCard from "../components/TableCard.vue";
import EmptyState from "../components/EmptyState.vue";
import FormField from "../components/FormField.vue";
import ToggleFormButton from "../components/ToggleFormButton.vue";
import TogglePill from "../components/TogglePill.vue";
import { Boxes } from "lucide-vue-next";

const {
  data: items,
  loading,
  errorMessage,
  load,
} = useResource<BundleSummary[]>(
  async () => (await api.get<{ items: BundleSummary[] }>("/admin-api/bundles")).items,
  [],
  "Failed to load bundles.",
);
const { rowError, toggle } = useOptimisticToggle<BundleSummary>((b) => b.name, "Failed to update.");

const showCreateForm = ref(false);
const newName = ref("");
const newDescription = ref("");
const newTools = ref<BundleToolRef[]>([]);
const createError = ref("");
const creating = ref(false);

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

function toggleEnabled(bundle: BundleSummary) {
  toggle(bundle, "enabled", (next) =>
    api.patch(`/admin-api/bundles/${encodeURIComponent(bundle.name)}`, { enabled: next }),
  );
}
</script>

<template>
  <section>
    <header class="page-header">
      <div>
        <h1>Bundles</h1>
        <p class="subtitle">
          Cross-client tool selections, each served at its own <code>/mcp-custom/&lt;name&gt;</code> endpoint.
        </p>
      </div>
      <ToggleFormButton v-model="showCreateForm" show-label="Create bundle" />
    </header>

    <form v-if="showCreateForm" class="create-form" @submit.prevent="createBundle">
      <FormField label="Name" for="new-bundle-name">
        <input id="new-bundle-name" v-model="newName" type="text" placeholder="e.g. assistant-a" required />
      </FormField>
      <p v-if="createError" class="error">{{ createError }}</p>
      <FormField label="Description (optional)" for="new-bundle-description">
        <input id="new-bundle-description" v-model="newDescription" type="text" placeholder="What this bundle is for" />
      </FormField>
      <div class="field">
        <label>Tools</label>
        <BundleToolPicker v-model="newTools" />
      </div>
      <button type="submit" class="btn-primary" :disabled="creating">
        {{ creating ? "Creating…" : "Create bundle" }}
      </button>
    </form>

    <p v-if="errorMessage" class="error" role="alert">{{ errorMessage }}</p>
    <SignalLoader v-if="loading" />

    <EmptyState v-else-if="items.length === 0" :icon="Boxes">
      No bundles yet. A bundle lets you hand an MCP client a curated, cross-client tool selection instead of one
      client's full tool list.
    </EmptyState>

    <TableCard v-else>
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
            <TogglePill
              :on="bundle.enabled"
              on-label="Disable bundle"
              off-label="Enable bundle"
              :aria-pressed="bundle.enabled"
              @click="toggleEnabled(bundle)"
            />
            <p v-if="rowError[bundle.name]" class="row-error">{{ rowError[bundle.name] }}</p>
          </td>
        </tr>
      </tbody>
    </TableCard>
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
  max-width: 32.5rem;
}
.create-form {
  background: var(--surface-sunken);
  padding: 1.25rem;
  border-radius: var(--radius-md);
  margin-bottom: 1.5rem;
  max-width: 30rem;
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
.desc-cell {
  color: var(--text-secondary);
  max-width: 20rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.row-error {
  color: var(--breach);
  font-size: 0.75rem;
  margin: 0.25rem 0 0;
}
.error {
  color: var(--breach);
}
</style>
