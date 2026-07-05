<script setup lang="ts">
import { onMounted } from "vue";
import { Combine } from "lucide-vue-next";
import { api } from "@/composables/useApi";
import { useResource } from "@/composables/useResource";
import { useConfirmAction } from "@/composables/useConfirmAction";
import { useOptimisticToggle } from "@/composables/useOptimisticToggle";
import { toErrorMessage } from "@/utils/errors";
import type { CompositeSummary } from "@/types/api";
import ConfirmDialog from "@/components/ui/ConfirmDialog.vue";
import PageHeader from "@/components/ui/PageHeader.vue";
import ListLayout from "@/components/ui/ListLayout.vue";
import TableCard from "@/components/ui/TableCard.vue";
import EmptyState from "@/components/ui/EmptyState.vue";
import TogglePill from "@/components/ui/TogglePill.vue";
import HoverPreview from "@/components/ui/HoverPreview.vue";

const {
  data: items,
  loading,
  errorMessage,
  load,
} = useResource<CompositeSummary[]>(
  async () => (await api.get<{ items: CompositeSummary[] }>("/admin-api/composites")).items,
  [],
  "Failed to load composites.",
);
const { rowError: toggleError, toggle } = useOptimisticToggle<CompositeSummary>((c) => c.name, "Failed to update.");

onMounted(load);

function toggleEnabled(c: CompositeSummary) {
  toggle(c, "enabled", (next) => api.patch(`/admin-api/composites/${encodeURIComponent(c.name)}`, { enabled: next }));
}

const {
  pending: pendingDelete,
  request: requestDelete,
  cancel: cancelDelete,
  confirm: confirmDeleteAction,
} = useConfirmAction<CompositeSummary>();

function confirmDelete() {
  return confirmDeleteAction(async (c) => {
    try {
      await api.delete(`/admin-api/composites/${encodeURIComponent(c.name)}`);
      await load();
    } catch (err) {
      errorMessage.value = toErrorMessage(err, "Failed to delete.");
    }
  });
}
</script>

<template>
  <section>
    <PageHeader title="Composite tools">
      <RouterLink to="/composites/new" class="btn-primary">New composite</RouterLink>
    </PageHeader>
    <p class="subtitle">
      Chains several existing tool calls into one, exposed on the aggregated MCP endpoint. Each step forwards to a real
      <code>client__tool</code> through the full guard stack.
    </p>

    <ListLayout :loading="loading" :error="errorMessage" :empty="items.length === 0">
      <template #empty>
        <EmptyState :icon="Combine">
          No composite tools yet. A composite chains several existing tool calls into one, exposed on the aggregated MCP
          endpoint.
        </EmptyState>
      </template>

      <TableCard>
        <thead>
          <tr>
            <th>Name</th>
            <th>Description</th>
            <th>Steps</th>
            <th>Enabled</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="c in items" :key="c.name">
            <td>
              <RouterLink :to="`/composites/${encodeURIComponent(c.name)}`">{{ c.name }}</RouterLink>
            </td>
            <td>
              <HoverPreview class="desc-cell" :text="c.description ?? ''">{{ c.description || "—" }}</HoverPreview>
            </td>
            <td>{{ c.stepsCount }}</td>
            <td>
              <TogglePill
                :on="c.enabled"
                on-label="Disable composite"
                off-label="Enable composite"
                :aria-pressed="c.enabled"
                @click="toggleEnabled(c)"
              />
              <p v-if="toggleError[c.name]" class="row-error">{{ toggleError[c.name] }}</p>
            </td>
            <td><button type="button" class="link-btn danger" @click="requestDelete(c)">Delete</button></td>
          </tr>
        </tbody>
      </TableCard>
    </ListLayout>

    <ConfirmDialog
      :open="pendingDelete !== null"
      title="Delete this composite?"
      :message="
        pendingDelete
          ? `MCP clients calling '${pendingDelete.name}' will start failing immediately. This cannot be undone.`
          : ''
      "
      :confirm-label="pendingDelete ? `Delete ${pendingDelete.name}` : 'Delete'"
      danger
      @confirm="confirmDelete"
      @cancel="cancelDelete"
    />
  </section>
</template>

<style scoped>
.subtitle {
  color: var(--text-secondary);
  margin: 0 0 1.25rem;
  max-width: 35rem;
}
.desc-cell {
  color: var(--text-secondary);
  max-width: 20rem;
}
</style>
