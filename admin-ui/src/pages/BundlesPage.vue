<script setup lang="ts">
import { ref, onMounted } from "vue";
import { api } from "../composables/useApi";
import { useResource } from "../composables/useResource";
import { useOptimisticToggle } from "../composables/useOptimisticToggle";
import { useEntityForm } from "@/composables/useEntityForm";
import type { BundleSummary, BundleDetail, BundleToolRef } from "../types/api";
import BundleToolPicker from "../components/BundleToolPicker.vue";
import PageHeader from "@/components/ui/PageHeader.vue";
import ListLayout from "@/components/ui/ListLayout.vue";
import TableCard from "@/components/ui/TableCard.vue";
import EmptyState from "@/components/ui/EmptyState.vue";
import FormField from "@/components/ui/FormField.vue";
import ToggleFormButton from "@/components/ui/ToggleFormButton.vue";
import TogglePill from "@/components/ui/TogglePill.vue";
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

const newName = ref("");
const newDescription = ref("");
const newTools = ref<BundleToolRef[]>([]);

function resetForm() {
  newName.value = "";
  newDescription.value = "";
  newTools.value = [];
}

const { open: showCreateForm, busy: creating, error: createError, submit } = useEntityForm<void>({ reset: resetForm });

onMounted(load);

async function createBundle() {
  if (!newName.value.trim()) {
    createError.value = "Name is required.";
    return;
  }
  const ok = await submit(async () => {
    await api.post<BundleDetail>("/admin-api/bundles", {
      name: newName.value.trim(),
      description: newDescription.value.trim() || undefined,
      tools: newTools.value,
    });
  }, "Failed to create bundle.");
  if (ok) await load();
}

function toggleEnabled(bundle: BundleSummary) {
  toggle(bundle, "enabled", (next) =>
    api.patch(`/admin-api/bundles/${encodeURIComponent(bundle.name)}`, { enabled: next }),
  );
}
</script>

<template>
  <section>
    <PageHeader title="Bundles">
      <ToggleFormButton v-model="showCreateForm" show-label="Create bundle" />
    </PageHeader>
    <p class="subtitle">
      Cross-client tool selections, each served at its own <code>/mcp-custom/&lt;name&gt;</code> endpoint.
    </p>

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

    <ListLayout :loading="loading" :error="errorMessage" :empty="items.length === 0">
      <template #empty>
        <EmptyState :icon="Boxes">
          No bundles yet. A bundle lets you hand an MCP client a curated, cross-client tool selection instead of one
          client's full tool list.
        </EmptyState>
      </template>

      <TableCard>
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
            <td class="cell-truncate desc-cell" :title="bundle.description || undefined">
              {{ bundle.description || "—" }}
            </td>
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
    </ListLayout>
  </section>
</template>

<style scoped>
.subtitle {
  color: var(--text-secondary);
  margin: 0 0 1.25rem;
  max-width: 32.5rem;
}
.create-form {
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
}
</style>
