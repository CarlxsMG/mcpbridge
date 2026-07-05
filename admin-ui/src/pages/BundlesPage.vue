<script setup lang="ts">
import { onMounted } from "vue";
import { useI18n } from "vue-i18n";
import { api } from "@/composables/useApi";
import { useResource } from "@/composables/useResource";
import { useOptimisticToggle } from "@/composables/useOptimisticToggle";
import { i18n } from "../i18n";
import type { BundleSummary } from "@/types/api";
import PageHeader from "@/components/ui/PageHeader.vue";
import ListLayout from "@/components/ui/ListLayout.vue";
import TableCard from "@/components/ui/TableCard.vue";
import EmptyState from "@/components/ui/EmptyState.vue";
import TogglePill from "@/components/ui/TogglePill.vue";
import HoverPreview from "@/components/ui/HoverPreview.vue";
import { Boxes } from "lucide-vue-next";

const { t } = useI18n({ useScope: "global" });
const errorFallback = (i18n.global.t as (k: string) => string)("errors.update_failed");
const loadFallback = (i18n.global.t as (k: string) => string)("pages.bundles.errors.load_failed");

const {
  data: items,
  loading,
  errorMessage,
  load,
} = useResource<BundleSummary[]>(
  async () => (await api.get<{ items: BundleSummary[] }>("/admin-api/bundles")).items,
  [],
  loadFallback,
);
const { rowError, toggle } = useOptimisticToggle<BundleSummary>((b) => b.name, errorFallback);

onMounted(load);

function toggleEnabled(bundle: BundleSummary) {
  toggle(bundle, "enabled", (next) =>
    api.patch(`/admin-api/bundles/${encodeURIComponent(bundle.name)}`, { enabled: next }),
  );
}
</script>

<template>
  <section>
    <PageHeader :title="t('pages.bundles.title')">
      <RouterLink to="/bundles/new" class="btn-primary">{{ t("pages.bundles.create") }}</RouterLink>
    </PageHeader>
    <p class="subtitle">
      {{ t("pages.bundles.subtitle") }}
    </p>

    <ListLayout :loading="loading" :error="errorMessage" :empty="items.length === 0">
      <template #empty>
        <EmptyState :icon="Boxes">
          {{ t("pages.bundles.empty.no_bundles") }}
        </EmptyState>
      </template>

      <TableCard>
        <thead>
          <tr>
            <th>{{ t("pages.bundles.table.name") }}</th>
            <th>{{ t("pages.bundles.table.description") }}</th>
            <th>{{ t("pages.bundles.table.tools") }}</th>
            <th>{{ t("pages.bundles.table.enabled") }}</th>
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
                :on-label="t('pages.bundles.table.disable_bundle')"
                :off-label="t('pages.bundles.table.enable_bundle')"
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
