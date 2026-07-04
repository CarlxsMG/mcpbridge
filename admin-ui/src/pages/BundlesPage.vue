<script setup lang="ts">
import { onMounted } from "vue";
import { api } from "@/composables/useApi";
import { useResource } from "@/composables/useResource";
import { useOptimisticToggle } from "@/composables/useOptimisticToggle";
import type { BundleSummary } from "@/types/api";
import PageHeader from "@/components/ui/PageHeader.vue";
import ListLayout from "@/components/ui/ListLayout.vue";
import TableCard from "@/components/ui/TableCard.vue";
import EmptyState from "@/components/ui/EmptyState.vue";
import TogglePill from "@/components/ui/TogglePill.vue";
import HoverPreview from "@/components/ui/HoverPreview.vue";
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

onMounted(load);

function toggleEnabled(bundle: BundleSummary) {
  toggle(bundle, "enabled", (next) =>
    api.patch(`/admin-api/bundles/${encodeURIComponent(bundle.name)}`, { enabled: next }),
  );
}
</script>

<template>
  <section>
    <PageHeader title="Bundles">
      <RouterLink to="/bundles/new" class="btn-primary">Create bundle</RouterLink>
    </PageHeader>
    <p class="subtitle">
      Cross-client tool selections, each served at its own <code>/mcp-custom/&lt;name&gt;</code> endpoint.
    </p>

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
            <td>
              <HoverPreview class="desc-cell" :text="bundle.description ?? ''">
                {{ bundle.description || "—" }}
              </HoverPreview>
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
.desc-cell {
  color: var(--text-secondary);
  max-width: 20rem;
}
</style>
