<script setup lang="ts">
import { ref, onMounted } from "vue";
import { useI18n } from "vue-i18n";
import { api } from "@/composables/useApi";
import { useConfirmAction } from "@/composables/useConfirmAction";
import { toErrorMessage } from "@/utils/errors";
import { formatDateTime } from "@/utils/format";
import { tk } from "@/i18n";
import type { ConfigImportResult, ConfigSnapshotSummary, ConfigDiffResult } from "@/types/api";
import ConfirmDialog from "@/components/ui/ConfirmDialog.vue";
import TableCard from "@/components/ui/TableCard.vue";

const emit = defineEmits<{ result: [result: ConfigImportResult]; error: [message: string] }>();
const { t } = useI18n({ useScope: "global" });

const snapshots = ref<ConfigSnapshotSummary[]>([]);
const newSnapshotLabel = ref("");
const snapshotBusy = ref(false);
const diff = ref<ConfigDiffResult | null>(null);
const {
  pending: pendingRollback,
  request: requestRollback,
  cancel: cancelRollback,
  confirm: confirmRollbackAction,
} = useConfirmAction<ConfigSnapshotSummary>();
const {
  pending: pendingDeleteSnapshot,
  request: requestDeleteSnapshot,
  cancel: cancelDeleteSnapshot,
  confirm: confirmDeleteSnapshotAction,
} = useConfirmAction<ConfigSnapshotSummary>();
const snapshotsError = ref("");

async function loadSnapshots() {
  snapshotsError.value = "";
  try {
    const res = await api.get<{ items: ConfigSnapshotSummary[] }>("/admin-api/config/snapshots");
    snapshots.value = res.items;
  } catch (err) {
    snapshotsError.value = toErrorMessage(err, tk("components.config_snapshots.errors.load_failed"));
  }
}
onMounted(loadSnapshots);

async function createSnapshotFn() {
  if (!newSnapshotLabel.value.trim()) return;
  snapshotBusy.value = true;
  emit("error", "");
  try {
    await api.post("/admin-api/config/snapshots", { label: newSnapshotLabel.value.trim() });
    newSnapshotLabel.value = "";
    await loadSnapshots();
  } catch (err) {
    emit("error", toErrorMessage(err, tk("components.config_snapshots.errors.create_failed")));
  } finally {
    snapshotBusy.value = false;
  }
}

async function showDiff(s: ConfigSnapshotSummary) {
  emit("error", "");
  diff.value = null;
  try {
    diff.value = await api.get<ConfigDiffResult>(`/admin-api/config/snapshots/${s.id}/diff?against=current`);
  } catch (err) {
    emit("error", toErrorMessage(err, tk("components.config_snapshots.errors.diff_failed")));
  }
}

async function confirmRollback() {
  await confirmRollbackAction(async (s) => {
    snapshotBusy.value = true;
    emit("error", "");
    try {
      emit("result", await api.post<ConfigImportResult>(`/admin-api/config/snapshots/${s.id}/rollback`, {}));
    } catch (err) {
      emit("error", toErrorMessage(err, tk("components.config_snapshots.errors.rollback_failed")));
    } finally {
      snapshotBusy.value = false;
    }
  });
}

async function confirmDeleteSnapshot() {
  await confirmDeleteSnapshotAction(async (s) => {
    try {
      await api.delete(`/admin-api/config/snapshots/${s.id}`);
      if (diff.value?.from.id === s.id) diff.value = null;
      await loadSnapshots();
    } catch (err) {
      emit("error", toErrorMessage(err, tk("components.config_snapshots.errors.delete_failed")));
    }
  });
}

function fmt(v: unknown): string {
  if (v === undefined) return "—";
  return typeof v === "object" ? JSON.stringify(v) : String(v);
}
</script>

<template>
  <div class="config-block">
    <h2>{{ t("components.config_snapshots.title") }}</h2>
    <p class="hint">{{ t("components.config_snapshots.hint") }}</p>
    <div class="actions">
      <label for="snapshot-label">{{ t("components.config_snapshots.snapshot_label") }}</label>
      <input
        id="snapshot-label"
        v-model="newSnapshotLabel"
        type="text"
        :placeholder="t('components.config_snapshots.snapshot_placeholder')"
        class="label-input"
      />
      <button
        type="button"
        class="btn-primary"
        :disabled="snapshotBusy || !newSnapshotLabel.trim()"
        @click="createSnapshotFn"
      >
        {{ t("components.config_snapshots.snapshot_now") }}
      </button>
    </div>
    <p v-if="snapshotsError" class="error" role="alert">{{ snapshotsError }}</p>
    <TableCard v-if="snapshots.length">
      <thead>
        <tr>
          <th>{{ t("components.config_snapshots.table.id") }}</th>
          <th>{{ t("components.config_snapshots.table.label") }}</th>
          <th>{{ t("components.config_snapshots.table.created") }}</th>
          <th>{{ t("components.config_snapshots.table.by") }}</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="s in snapshots" :key="s.id">
          <td>{{ s.id }}</td>
          <td>{{ s.label }}</td>
          <td>{{ formatDateTime(s.createdAt) }}</td>
          <td>{{ s.createdBy }}</td>
          <td class="row-actions">
            <button type="button" class="link-btn" @click="showDiff(s)">
              {{ t("components.config_snapshots.diff_vs_current") }}
            </button>
            <button type="button" class="link-btn" @click="requestRollback(s)">
              {{ t("components.config_snapshots.rollback") }}
            </button>
            <button type="button" class="link-btn del" @click="requestDeleteSnapshot(s)">
              {{ t("common.delete") }}
            </button>
          </td>
        </tr>
      </tbody>
    </TableCard>
    <p v-else-if="!snapshotsError" class="hint">
      {{ t("components.config_snapshots.empty") }}
    </p>

    <div v-if="diff" class="diff">
      <h3>
        {{ t("components.config_snapshots.diff_heading", { id: diff.from.id, label: diff.from.label }) }} →
        {{ diff.to }}
      </h3>
      <p v-if="diff.entries.length === 0" class="hint">{{ t("components.config_snapshots.no_differences") }}</p>
      <TableCard v-else>
        <thead>
          <tr>
            <th>{{ t("components.config_snapshots.diff_table.path") }}</th>
            <th>{{ t("components.config_snapshots.diff_table.change") }}</th>
            <th>{{ t("components.config_snapshots.diff_table.before") }}</th>
            <th>{{ t("components.config_snapshots.diff_table.after") }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="e in diff.entries" :key="e.path" :class="e.kind">
            <td>
              <code>{{ e.path }}</code>
            </td>
            <td>{{ e.kind }}</td>
            <td>
              <code>{{ fmt(e.before) }}</code>
            </td>
            <td>
              <code>{{ fmt(e.after) }}</code>
            </td>
          </tr>
        </tbody>
      </TableCard>
    </div>
  </div>

  <ConfirmDialog
    :open="pendingRollback !== null"
    :title="t('components.config_snapshots.confirm.rollback_title')"
    :message="
      pendingRollback ? t('components.config_snapshots.confirm.rollback_message', { label: pendingRollback.label }) : ''
    "
    :confirm-label="t('components.config_snapshots.confirm.rollback_cta')"
    danger
    @confirm="confirmRollback"
    @cancel="cancelRollback"
  />

  <ConfirmDialog
    :open="pendingDeleteSnapshot !== null"
    :title="t('components.config_snapshots.confirm.delete_title')"
    :message="
      pendingDeleteSnapshot
        ? t('components.config_snapshots.confirm.delete_message', { label: pendingDeleteSnapshot.label })
        : ''
    "
    :confirm-label="
      pendingDeleteSnapshot
        ? t('components.config_snapshots.confirm.delete_cta', { label: pendingDeleteSnapshot.label })
        : t('common.delete')
    "
    danger
    @confirm="confirmDeleteSnapshot"
    @cancel="cancelDeleteSnapshot"
  />
</template>
