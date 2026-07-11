<script setup lang="ts">
import { onMounted } from "vue";
import { useI18n } from "vue-i18n";
import { Combine } from "lucide-vue-next";
import { api } from "@/composables/useApi";
import { useResource } from "@/composables/useResource";
import { useConfirmAction } from "@/composables/useConfirmAction";
import { useOptimisticToggle } from "@/composables/useOptimisticToggle";
import { toErrorMessage } from "@/utils/errors";
import { compositePath } from "@/utils/apiPaths";
import { i18n } from "../i18n";
import type { CompositeSummary } from "@/types/api";
import ConfirmDialog from "@/components/ui/ConfirmDialog.vue";
import PageHeader from "@/components/ui/PageHeader.vue";
import ListLayout from "@/components/ui/ListLayout.vue";
import TableCard from "@/components/ui/TableCard.vue";
import EmptyState from "@/components/ui/EmptyState.vue";
import TogglePill from "@/components/ui/TogglePill.vue";
import HoverPreview from "@/components/ui/HoverPreview.vue";

const { t } = useI18n({ useScope: "global" });
const tk = (k: string) => (i18n.global.t as (key: string) => string)(k);

const loadFallback = tk("pages.composites.errors.load_failed");
const toggleFallback = tk("pages.composites.errors.update_failed");

const {
  data: items,
  loading,
  errorMessage,
  load,
} = useResource<CompositeSummary[]>(
  async () => (await api.get<{ items: CompositeSummary[] }>("/admin-api/composites")).items,
  [],
  loadFallback,
);
const { rowError: toggleError, toggle } = useOptimisticToggle<CompositeSummary>((c) => c.name, toggleFallback);

onMounted(load);

function toggleEnabled(c: CompositeSummary) {
  toggle(c, "enabled", (next) => api.patch(compositePath(c.name), { enabled: next }));
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
      await api.delete(compositePath(c.name));
      await load();
    } catch (err) {
      errorMessage.value = toErrorMessage(err, toggleFallback);
    }
  });
}
</script>

<template>
  <section>
    <PageHeader :title="t('pages.composites.title')">
      <RouterLink to="/composites/new" class="btn-primary">{{ t("pages.composites.create") }}</RouterLink>
    </PageHeader>
    <p class="subtitle">{{ t("pages.composites.subtitle") }}</p>

    <ListLayout :loading="loading" :error="errorMessage" :empty="items.length === 0">
      <template #empty>
        <EmptyState :icon="Combine">{{ t("pages.composites.empty.no_composites") }}</EmptyState>
      </template>

      <TableCard>
        <thead>
          <tr>
            <th>{{ t("pages.composites.table.name") }}</th>
            <th>{{ t("pages.composites.table.description") }}</th>
            <th>{{ t("pages.composites.table.steps") }}</th>
            <th>{{ t("pages.composites.table.enabled") }}</th>
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
                :on-label="t('pages.composites.table.disable')"
                :off-label="t('pages.composites.table.enable')"
                :aria-pressed="c.enabled"
                @click="toggleEnabled(c)"
              />
              <p v-if="toggleError[c.name]" class="row-error">{{ toggleError[c.name] }}</p>
            </td>
            <td>
              <button type="button" class="link-btn danger" @click="requestDelete(c)">{{ t("common.delete") }}</button>
            </td>
          </tr>
        </tbody>
      </TableCard>
    </ListLayout>

    <ConfirmDialog
      :open="pendingDelete !== null"
      :title="t('pages.composites.confirm.delete_title')"
      :message="pendingDelete ? t('pages.composites.confirm.delete_message', { name: pendingDelete.name }) : ''"
      :confirm-label="
        pendingDelete ? t('pages.composites.confirm.delete_label', { name: pendingDelete.name }) : t('common.delete')
      "
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
