<script setup lang="ts">
import { ref, computed, onMounted } from "vue";
import { useI18n } from "vue-i18n";
import { useRouter } from "vue-router";
import { api } from "@/composables/useApi";
import { useResource } from "@/composables/useResource";
import { useConfirmAction } from "@/composables/useConfirmAction";
import { toErrorMessage } from "@/utils/errors";
import { i18n } from "../i18n";
import type { CatalogEntry, DiscoveryPreview, DiscoveredTool } from "@/types/api";
import { LayoutGrid } from "lucide-vue-next";
import ConfirmDialog from "@/components/ui/ConfirmDialog.vue";
import PageHeader from "@/components/ui/PageHeader.vue";
import ListLayout from "@/components/ui/ListLayout.vue";
import EmptyState from "@/components/ui/EmptyState.vue";
import FormField from "@/components/ui/FormField.vue";
import KindBadge from "@/components/ui/KindBadge.vue";

const { t } = useI18n({ useScope: "global" });
const tk = (k: string) => (i18n.global.t as (key: string) => string)(k);

const router = useRouter();

const loadFallback = tk("pages.catalog.errors.load_failed");

const {
  data: items,
  loading,
  errorMessage,
  load,
} = useResource<CatalogEntry[]>(
  async () => (await api.get<{ items: CatalogEntry[] }>("/admin-api/catalog")).items,
  [],
  loadFallback,
);

const sorted = computed(() =>
  [...items.value].sort((a, b) => (a.featured === b.featured ? a.name.localeCompare(b.name) : a.featured ? -1 : 1)),
);

onMounted(load);

const openEntryId = ref<string | null>(null);
const installName = ref("");
const previewTools = ref<DiscoveredTool[] | null>(null);
const previewing = ref(false);
const previewError = ref("");
const installing = ref(false);
const installError = ref("");

function toggleInstall(entry: CatalogEntry) {
  if (openEntryId.value === entry.id) {
    openEntryId.value = null;
    return;
  }
  openEntryId.value = entry.id;
  installName.value = entry.slug;
  previewTools.value = null;
  previewError.value = "";
  installError.value = "";
}

async function preview(entry: CatalogEntry) {
  if (!entry.openapiUrl) return;
  previewing.value = true;
  previewError.value = "";
  try {
    const res = await api.post<DiscoveryPreview>("/admin-api/discovery/preview", {
      openapi_url: entry.openapiUrl,
      include_tags: entry.includeTags ?? undefined,
      exclude_operations: entry.excludeOperations ?? undefined,
    });
    previewTools.value = res.tools;
  } catch (err) {
    previewError.value = toErrorMessage(err, tk("errors.preview_failed"));
  } finally {
    previewing.value = false;
  }
}

async function confirmInstall(entry: CatalogEntry) {
  installError.value = "";
  if (!installName.value.trim()) {
    installError.value = t("pages.catalog.errors.name_required");
    return;
  }
  installing.value = true;
  try {
    await api.post(`/admin-api/catalog/${encodeURIComponent(entry.id)}/install`, { name: installName.value.trim() });
    await router.push(`/servers/${encodeURIComponent(installName.value.trim())}`);
  } catch (err) {
    installError.value = toErrorMessage(err, tk("pages.catalog.errors.install_failed"));
  } finally {
    installing.value = false;
  }
}

const {
  pending: pendingDelete,
  request: requestDelete,
  cancel: cancelDelete,
  confirm: confirmActionDelete,
} = useConfirmAction<CatalogEntry>();

function deleteEntry(entry: CatalogEntry) {
  requestDelete(entry);
}

function confirmDelete() {
  return confirmActionDelete(async (entry) => {
    try {
      await api.delete(`/admin-api/catalog/${encodeURIComponent(entry.id)}`);
      await load();
    } catch (err) {
      errorMessage.value = toErrorMessage(err, tk("pages.catalog.errors.delete_failed"));
    }
  });
}
</script>

<template>
  <section>
    <PageHeader :title="t('pages.catalog.title')" :subtitle="t('pages.catalog.subtitle')">
      <RouterLink to="/catalog/new" class="btn-primary">{{ t("pages.catalog.add_entry") }}</RouterLink>
    </PageHeader>

    <ListLayout :loading="loading" :error="errorMessage" :empty="items.length === 0">
      <template #empty>
        <EmptyState :icon="LayoutGrid">{{ t("pages.catalog.empty.no_entries") }}</EmptyState>
      </template>

      <div class="catalog-grid">
        <article
          v-for="entry in sorted"
          :key="entry.id"
          class="catalog-card"
          :class="{ 'is-open': openEntryId === entry.id }"
        >
          <div class="card-top">
            <KindBadge :kind="entry.kind" />
            <span v-if="entry.featured" class="featured-badge">{{ t("pages.catalog.featured") }}</span>
            <span v-if="entry.source === 'custom'" class="custom-badge">{{ t("pages.catalog.custom") }}</span>
          </div>
          <h3>{{ entry.name }}</h3>
          <p class="desc">{{ entry.description || t("pages.catalog.no_description") }}</p>
          <p v-if="entry.category" class="category">{{ entry.category }}</p>
          <div v-if="entry.tags.length" class="tags">
            <span v-for="tag in entry.tags" :key="tag" class="tag">{{ tag }}</span>
          </div>

          <div class="card-actions">
            <button type="button" class="btn-secondary" @click="toggleInstall(entry)">
              {{ openEntryId === entry.id ? t("common.cancel") : t("pages.catalog.table.install") }}
            </button>
            <button v-if="entry.source === 'custom'" type="button" class="link-btn danger" @click="deleteEntry(entry)">
              {{ t("common.delete") }}
            </button>
          </div>

          <div v-if="openEntryId === entry.id" class="install-panel">
            <FormField :label="t('pages.catalog.install_as')" :for="`install-name-${entry.id}`">
              <input :id="`install-name-${entry.id}`" v-model="installName" type="text" />
            </FormField>
            <template v-if="entry.kind === 'rest' && entry.openapiUrl">
              <div class="preview-row">
                <button type="button" class="btn-secondary" :disabled="previewing" @click="preview(entry)">
                  {{ previewing ? t("pages.register_server.discovering") : t("pages.register_server.preview_tools") }}
                </button>
                <span v-if="previewTools" class="preview-count">{{
                  t("pages.register_server.preview_count", { count: previewTools.length })
                }}</span>
              </div>
              <p v-if="previewError" class="error">{{ previewError }}</p>
            </template>
            <p v-else class="hint">
              {{ t("pages.register_server.mcp_transport_hint") }}
            </p>
            <p v-if="installError" class="error">{{ installError }}</p>
            <button type="button" class="btn-primary" :disabled="installing" @click="confirmInstall(entry)">
              {{ installing ? t("pages.catalog.installing") : t("pages.catalog.confirm_install") }}
            </button>
          </div>
        </article>
      </div>
    </ListLayout>

    <ConfirmDialog
      :open="pendingDelete !== null"
      :title="t('pages.catalog.confirm.delete_title')"
      :message="pendingDelete ? t('pages.catalog.confirm.delete_message', { name: pendingDelete.name }) : ''"
      :confirm-label="
        pendingDelete ? t('pages.catalog.confirm.delete_label', { name: pendingDelete.name }) : t('common.delete')
      "
      danger
      @confirm="confirmDelete"
      @cancel="cancelDelete"
    />
  </section>
</template>

<style scoped>
:deep(.subtitle) {
  max-width: 35rem;
}
.catalog-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(16.25rem, 1fr));
  gap: 1rem;
}
.catalog-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-xs);
  padding: 1rem;
  display: flex;
  flex-direction: column;
}
.catalog-card.is-open {
  border-color: var(--accent, var(--border-strong));
}
.card-top {
  display: flex;
  gap: 0.4rem;
  margin-bottom: 0.5rem;
}
.featured-badge,
.custom-badge {
  font-size: 0.68rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  padding: 0.15rem 0.5rem;
  border-radius: var(--radius-pill);
}
.featured-badge {
  background: var(--ok-soft, var(--surface-sunken));
  color: var(--ok);
}
.custom-badge {
  border: 1px solid var(--border-strong);
  color: var(--text-secondary);
}
.catalog-card h3 {
  margin: 0 0 0.3rem;
  font-size: 1rem;
}
.desc {
  color: var(--text-secondary);
  font-size: 0.85rem;
  margin: 0 0 0.4rem;
  flex-grow: 1;
}
.category {
  font-size: 0.78rem;
  color: var(--text-muted);
  margin: 0 0 0.4rem;
}
.tags {
  display: flex;
  flex-wrap: wrap;
  gap: 0.3rem;
  margin-bottom: 0.75rem;
}
.tag {
  font-size: 0.72rem;
  background: var(--surface-sunken);
  color: var(--text-secondary);
  padding: 0.1rem 0.5rem;
  border-radius: var(--radius-pill);
}
.card-actions {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}
.install-panel {
  margin-top: 0.85rem;
  padding-top: 0.85rem;
  border-top: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}
.preview-row {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}
.preview-count {
  font-size: 0.85rem;
  color: var(--ok);
}
.hint {
  font-size: 0.8rem;
  color: var(--text-secondary);
  margin: 0;
}
</style>
