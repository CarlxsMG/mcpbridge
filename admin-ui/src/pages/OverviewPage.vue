<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
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

const layout = useDashboardLayout();

const WINDOWS = [
  { label: "24 hours", ms: 24 * 60 * 60_000 },
  { label: "7 days", ms: 7 * 24 * 60 * 60_000 },
  { label: "30 days", ms: 30 * 24 * 60 * 60_000 },
];
const WINDOW_OPTIONS = WINDOWS.map((w) => ({ value: w.ms, label: `Last ${w.label}` }));
const windowMs = ref(WINDOWS[1].ms);

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
// Preserve the original page's onboarding nudge when there are no live servers.
const showNoServers = computed(() => data.stores.overview !== null && data.stores.overview.clients.live === 0);

function onAdd(preset: WidgetPreset): void {
  const id = layout.addPreset(preset);
  showAdd.value = false;
  // "Custom" entries (e.g. Note) land blank-ish — open the builder immediately.
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
  input.value = ""; // allow re-importing the same file later
  if (!file) return;
  try {
    layout.importJson(await file.text());
    errorMessage.value = "";
  } catch (err) {
    errorMessage.value = `Import failed: ${(err as Error).message}`;
  }
}

onMounted(() => data.refresh());
</script>

<template>
  <section>
    <PageHeader
      title="Overview"
      subtitle="A live snapshot of this bridge — build it out of the widgets you care about."
    >
      <div class="ov-actions">
        <SelectMenu v-model="windowMs" aria-label="Time window" :options="WINDOW_OPTIONS" />
        <button type="button" class="btn-secondary" :disabled="data.loading.value" @click="data.refresh()">
          <RefreshCw :size="14" stroke-width="2" aria-hidden="true" :class="{ spin: data.loading.value }" />
          {{ data.loading.value ? "Refreshing…" : "Refresh" }}
        </button>

        <template v-if="editing">
          <button type="button" class="btn-primary" @click="showAdd = true">
            <Plus :size="14" stroke-width="2" aria-hidden="true" /> Add widget
          </button>
          <button type="button" class="btn-secondary" title="Export layout as JSON" @click="exportLayout">
            <Download :size="14" stroke-width="2" aria-hidden="true" /> Export
          </button>
          <button type="button" class="btn-secondary" title="Import a layout JSON" @click="triggerImport">
            <Upload :size="14" stroke-width="2" aria-hidden="true" /> Import
          </button>
          <button
            type="button"
            class="btn-secondary"
            title="Restore the default layout"
            @click="showResetConfirm = true"
          >
            <RotateCcw :size="14" stroke-width="2" aria-hidden="true" /> Reset
          </button>
        </template>

        <button type="button" class="btn-secondary" :aria-pressed="editing" @click="editing = !editing">
          <SlidersHorizontal :size="14" stroke-width="2" aria-hidden="true" />
          {{ editing ? "Done" : "Edit" }}
        </button>
        <input
          ref="importInput"
          type="file"
          accept="application/json,.json"
          class="visually-hidden"
          @change="onImportFile"
        />
      </div>
    </PageHeader>

    <p v-if="errorMessage" class="error" role="alert">{{ errorMessage }}</p>

    <p v-if="showNoServers" class="onboarding-note">
      <Server :size="15" stroke-width="2" aria-hidden="true" />
      No servers registered yet. <RouterLink to="/register-server">Add a server</RouterLink> or
      <RouterLink to="/catalog">browse the catalog</RouterLink> — your widgets will fill in once traffic flows.
    </p>

    <p v-if="editing" class="edit-hint">
      Drag the <strong>⠿</strong> handle to move a widget, drag its bottom-right corner to resize, or use each widget's
      controls. Changes are saved automatically to this browser.
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
      Your dashboard is empty.
      <button type="button" class="link-btn" @click="showAdd = true">Add a widget</button>
      or
      <button type="button" class="link-btn" @click="layout.resetToDefault()">reset to the default layout</button>.
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
      title="Reset dashboard?"
      message="This replaces your current layout with the default set of widgets. Your customizations to this dashboard will be lost."
      confirm-label="Reset to default"
      danger
      @confirm="confirmReset"
      @cancel="showResetConfirm = false"
    />
  </section>
</template>

<style scoped>
/* PageHeader renders the .header-actions wrapper; reach into it to lay the
   controls out in a wrapping row (matches the other observability pages). */
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
