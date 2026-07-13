<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { useDashboardLayout } from "@/composables/useDashboardLayout";
import { useDashboardData } from "@/composables/useDashboardData";
import { neededSources, type WidgetPreset, type WidgetOptions } from "@/components/overview/widgetCatalog";
import { downloadTextFile } from "@/utils/download";
import PageHeader from "@/components/ui/PageHeader.vue";
import SelectMenu from "@/components/ui/SelectMenu.vue";
import EmptyState from "@/components/ui/EmptyState.vue";
import ConfirmDialog from "@/components/ui/ConfirmDialog.vue";
import WidgetGrid from "@/components/overview/WidgetGrid.vue";
import AddWidgetDialog from "@/components/overview/AddWidgetDialog.vue";
import WidgetConfigDialog from "@/components/overview/WidgetConfigDialog.vue";
import {
  RefreshCw,
  SlidersHorizontal,
  Plus,
  RotateCcw,
  Download,
  Upload,
  Server,
  LayoutDashboard,
} from "lucide-vue-next";

const { t } = useI18n({ useScope: "global" });

const layout = useDashboardLayout();

const WINDOW_VALUES = [
  { labelKey: "pages.overview.last_24h", ms: 24 * 60 * 60_000 },
  { labelKey: "pages.overview.last_7d", ms: 7 * 24 * 60 * 60_000 },
  { labelKey: "pages.overview.last_30d", ms: 30 * 24 * 60 * 60_000 },
];
const WINDOW_OPTIONS = WINDOW_VALUES.map((w) => ({ value: w.ms, label: t(w.labelKey) }));
const windowMs = ref(WINDOW_VALUES[1].ms);

const sources = computed(() => neededSources(layout.widgets.value));
const data = useDashboardData(sources, windowMs);

const editing = ref(false);
const showAdd = ref(false);
const showResetConfirm = ref(false);
const configuringId = ref<string | null>(null);
const importInput = ref<HTMLInputElement | null>(null);
const errorMessage = ref("");

const configuringWidget = computed(() => layout.widgets.value.find((w) => w.id === configuringId.value) ?? null);
const isEmpty = computed(() => layout.widgets.value.length === 0);
const showNoServers = computed(() => data.stores.overview !== null && data.stores.overview.clients.live === 0);

function onAdd(preset: WidgetPreset): void {
  const id = layout.addPreset(preset);
  showAdd.value = false;
  if (preset.group === "custom") configuringId.value = id;
}
function onRemove(id: string): void {
  layout.remove(id);
  if (configuringId.value === id) configuringId.value = null;
}
function onSaveConfig(payload: { id: string; options: WidgetOptions; w: number; h: number }): void {
  layout.configure(payload.id, payload.options);
  layout.resize(payload.id, payload.w, payload.h);
  configuringId.value = null;
}

function confirmReset(): void {
  layout.resetToDefault();
  showResetConfirm.value = false;
}
function exportLayout(): void {
  downloadTextFile("overview-dashboard.json", layout.exportJson());
}
function triggerImport(): void {
  importInput.value?.click();
}
async function onImportFile(e: Event): Promise<void> {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;
  try {
    layout.importJson(await file.text());
    errorMessage.value = "";
  } catch (err) {
    errorMessage.value = t("pages.overview.import_error_prefix") + (err as Error).message;
  }
}

onMounted(() => data.refresh());
</script>

<template>
  <section>
    <PageHeader :title="t('pages.overview.title')" :subtitle="t('pages.overview.subtitle')">
      <div class="ov-actions">
        <SelectMenu v-model="windowMs" :aria-label="t('pages.overview.time_window_aria')" :options="WINDOW_OPTIONS" />
        <button type="button" class="btn-secondary" :disabled="data.loading.value" @click="data.refresh()">
          <RefreshCw :size="14" stroke-width="2" aria-hidden="true" :class="{ spin: data.loading.value }" />
          {{ data.loading.value ? t("pages.overview.refreshing") : t("common.refresh") }}
        </button>

        <template v-if="editing">
          <button type="button" class="btn-primary" @click="showAdd = true">
            <Plus :size="14" stroke-width="2" aria-hidden="true" /> {{ t("pages.overview.add_widget") }}
          </button>
          <button type="button" class="btn-secondary" :title="t('pages.overview.export_layout')" @click="exportLayout">
            <Download :size="14" stroke-width="2" aria-hidden="true" /> {{ t("pages.overview.export") }}
          </button>
          <button type="button" class="btn-secondary" :title="t('pages.overview.import_layout')" @click="triggerImport">
            <Upload :size="14" stroke-width="2" aria-hidden="true" /> {{ t("pages.overview.import") }}
          </button>
          <button
            type="button"
            class="btn-secondary"
            :title="t('pages.overview.restore_default_layout')"
            @click="showResetConfirm = true"
          >
            <RotateCcw :size="14" stroke-width="2" aria-hidden="true" /> {{ t("common.reset") }}
          </button>
        </template>

        <button type="button" class="btn-secondary" :aria-pressed="editing" @click="editing = !editing">
          <SlidersHorizontal :size="14" stroke-width="2" aria-hidden="true" />
          {{ editing ? t("pages.overview.done") : t("pages.overview.edit") }}
        </button>
        <input
          ref="importInput"
          type="file"
          accept="application/json,.json"
          class="visually-hidden"
          :aria-label="t('pages.overview.import_layout')"
          @change="onImportFile"
        />
      </div>
    </PageHeader>

    <p v-if="errorMessage" class="error" role="alert">{{ errorMessage }}</p>

    <p v-if="showNoServers" class="onboarding-note">
      <Server :size="15" stroke-width="2" aria-hidden="true" />
      {{ t("pages.overview.empty.no_servers") }}
      <RouterLink to="/register-server">{{ t("pages.overview.empty.add_server") }}</RouterLink> or
      <RouterLink to="/catalog">{{ t("pages.overview.empty.browse_catalog") }}</RouterLink>
    </p>

    <p v-if="editing" class="edit-hint">
      {{ t("pages.overview.empty.edit_hint") }}
    </p>

    <WidgetGrid
      v-if="!isEmpty"
      :widgets="layout.widgets.value"
      :stores="data.stores"
      :editing="editing"
      @configure="(id) => (configuringId = id)"
      @remove="onRemove"
      @move="layout.move"
      @reorder="layout.reorder"
      @resize="layout.resize"
    />

    <EmptyState v-else :icon="LayoutDashboard">
      {{ t("pages.overview.empty.dashboard_empty") }}
      <button type="button" class="link-btn" @click="showAdd = true">
        {{ t("pages.overview.empty.add_widget_button") }}
      </button>
      {{ t("common.or") }}
      <button type="button" class="link-btn" @click="layout.resetToDefault()">
        {{ t("pages.overview.empty.reset_to_default") }}</button
      >.
    </EmptyState>

    <AddWidgetDialog :open="showAdd" @close="showAdd = false" @add="onAdd" />
    <WidgetConfigDialog
      :open="configuringId !== null"
      :widget="configuringWidget"
      @close="configuringId = null"
      @save="onSaveConfig"
    />
    <ConfirmDialog
      :open="showResetConfirm"
      :title="t('pages.overview.reset_confirm.title')"
      :message="t('pages.overview.reset_confirm.message')"
      :confirm-label="t('pages.overview.reset_confirm.confirm_label')"
      danger
      @confirm="confirmReset"
      @cancel="showResetConfirm = false"
    />
  </section>
</template>

<style scoped>
:deep(.header-actions) {
  min-width: 0;
}
.ov-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: var(--space-2);
}
.ov-actions .btn-primary,
.ov-actions .btn-secondary {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
}
.onboarding-note {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin: 0 0 var(--space-4);
  padding: var(--space-3) var(--space-4);
  background: var(--signal-soft);
  border: 1px solid var(--signal);
  border-radius: var(--radius-md);
  color: var(--text-secondary);
  font-size: var(--text-sm);
}
.onboarding-note svg {
  color: var(--signal-strong);
  flex-shrink: 0;
}
.edit-hint {
  margin: 0 0 var(--space-4);
  color: var(--text-secondary);
  font-size: var(--text-sm);
}
.visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}
</style>
