<script setup lang="ts">
import { ref, onMounted } from "vue";
import { api } from "@/composables/useApi";
import { useConfirmAction } from "@/composables/useConfirmAction";
import { toErrorMessage } from "@/utils/errors";
import { formatDateTime } from "@/utils/format";
import type { ConfigImportResult, ConfigSnapshotSummary, ConfigDiffResult } from "@/types/api";
import ConfirmDialog from "@/components/ui/ConfirmDialog.vue";
import TableCard from "@/components/ui/TableCard.vue";

const emit = defineEmits<{ result: [result: ConfigImportResult]; error: [message: string] }>();

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
    snapshotsError.value = toErrorMessage(err, "Failed to load snapshots.");
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
    emit("error", toErrorMessage(err, "Failed to create snapshot."));
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
    emit("error", toErrorMessage(err, "Failed to diff."));
  }
}

async function confirmRollback() {
  await confirmRollbackAction(async (s) => {
    snapshotBusy.value = true;
    emit("error", "");
    try {
      emit("result", await api.post<ConfigImportResult>(`/admin-api/config/snapshots/${s.id}/rollback`, {}));
    } catch (err) {
      emit("error", toErrorMessage(err, "Rollback failed."));
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
      emit("error", toErrorMessage(err, "Delete failed."));
    }
  });
}

function fmt(v: unknown): string {
  if (v === undefined) return "—";
  return typeof v === "object" ? JSON.stringify(v) : String(v);
}
</script>

<template>
  <div class="block">
    <h2>Version history</h2>
    <p class="hint">Snapshot the current config, diff a snapshot against the live config, or roll back to it.</p>
    <div class="actions">
      <label for="snapshot-label">Snapshot label</label>
      <input
        id="snapshot-label"
        v-model="newSnapshotLabel"
        type="text"
        placeholder="Snapshot label (e.g. before-migration)"
        class="label-input"
      />
      <button
        type="button"
        class="btn-primary"
        :disabled="snapshotBusy || !newSnapshotLabel.trim()"
        @click="createSnapshotFn"
      >
        Snapshot now
      </button>
    </div>
    <p v-if="snapshotsError" class="error" role="alert">{{ snapshotsError }}</p>
    <TableCard v-if="snapshots.length">
      <thead>
        <tr>
          <th>#</th>
          <th>Label</th>
          <th>Created</th>
          <th>By</th>
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
            <button type="button" class="link-btn" @click="showDiff(s)">diff vs current</button>
            <button type="button" class="link-btn" @click="requestRollback(s)">rollback</button>
            <button type="button" class="link-btn del" @click="requestDeleteSnapshot(s)">delete</button>
          </td>
        </tr>
      </tbody>
    </TableCard>
    <p v-else-if="!snapshotsError" class="hint">
      No snapshots yet. A snapshot captures the full config -- bundles, guardrails, consumers, and more -- so you can
      compare or roll back later.
    </p>

    <div v-if="diff" class="diff">
      <h3>Diff: #{{ diff.from.id }} “{{ diff.from.label }}” → {{ diff.to }}</h3>
      <p v-if="diff.entries.length === 0" class="hint">No differences.</p>
      <TableCard v-else>
        <thead>
          <tr>
            <th>Path</th>
            <th>Change</th>
            <th>Before</th>
            <th>After</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(e, i) in diff.entries" :key="i" :class="e.kind">
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
    title="Roll back this config?"
    :message="
      pendingRollback
        ? `Roll back config to snapshot '${pendingRollback.label}'? This re-applies it to existing servers.`
        : ''
    "
    confirm-label="Roll back"
    danger
    @confirm="confirmRollback"
    @cancel="cancelRollback"
  />

  <ConfirmDialog
    :open="pendingDeleteSnapshot !== null"
    title="Delete this snapshot?"
    :message="pendingDeleteSnapshot ? `Delete snapshot '${pendingDeleteSnapshot.label}'?` : ''"
    :confirm-label="pendingDeleteSnapshot ? `Delete ${pendingDeleteSnapshot.label}` : 'Delete'"
    danger
    @confirm="confirmDeleteSnapshot"
    @cancel="cancelDeleteSnapshot"
  />
</template>
