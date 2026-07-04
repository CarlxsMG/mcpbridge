<script setup lang="ts">
import { ref, onMounted } from "vue";
import { api } from "../composables/useApi";
import { useConfirmAction } from "../composables/useConfirmAction";
import { toErrorMessage } from "@/utils/errors";
import { formatDateTime } from "@/utils/format";
import { downloadTextFile } from "@/utils/download";
import type { ConfigImportResult, ConfigSnapshotSummary, ConfigDiffResult } from "../types/api";
import ConfirmDialog from "@/components/ui/ConfirmDialog.vue";
import PageHeader from "@/components/ui/PageHeader.vue";

const exporting = ref(false);
const importText = ref("");
const exportFormat = ref<"json" | "yaml">("json");
const importFormat = ref<"json" | "yaml">("json");
const jsonPlaceholder = '{ "version": 1, ... }';
const result = ref<ConfigImportResult | null>(null);
const resultKind = ref<"import" | "rollback">("import");
const busy = ref(false);
const errorMessage = ref("");
const {
  pending: pendingImportConfirm,
  request: requestImportConfirm,
  cancel: cancelImportConfirm,
  confirm: confirmImportAction,
} = useConfirmAction<true>();

// Version history
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
  errorMessage.value = "";
  try {
    await api.post("/admin-api/config/snapshots", { label: newSnapshotLabel.value.trim() });
    newSnapshotLabel.value = "";
    await loadSnapshots();
  } catch (err) {
    errorMessage.value = toErrorMessage(err, "Failed to create snapshot.");
  } finally {
    snapshotBusy.value = false;
  }
}

async function showDiff(s: ConfigSnapshotSummary) {
  errorMessage.value = "";
  diff.value = null;
  try {
    diff.value = await api.get<ConfigDiffResult>(`/admin-api/config/snapshots/${s.id}/diff?against=current`);
  } catch (err) {
    errorMessage.value = toErrorMessage(err, "Failed to diff.");
  }
}

async function confirmRollback() {
  await confirmRollbackAction(async (s) => {
    snapshotBusy.value = true;
    errorMessage.value = "";
    try {
      resultKind.value = "rollback";
      result.value = await api.post<ConfigImportResult>(`/admin-api/config/snapshots/${s.id}/rollback`, {});
    } catch (err) {
      errorMessage.value = toErrorMessage(err, "Rollback failed.");
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
      errorMessage.value = toErrorMessage(err, "Delete failed.");
    }
  });
}

function fmt(v: unknown): string {
  if (v === undefined) return "—";
  return typeof v === "object" ? JSON.stringify(v) : String(v);
}

async function doExport() {
  exporting.value = true;
  errorMessage.value = "";
  try {
    // Formatting/parsing happens server-side — the admin UI never needs its
    // own YAML dependency, it just relays the raw text the backend produced.
    const suffix = exportFormat.value === "yaml" ? "?format=yaml" : "";
    const raw = await api.getRaw(`/admin-api/config/export${suffix}`);
    const mime = exportFormat.value === "yaml" ? "application/yaml" : "application/json";
    const filename = exportFormat.value === "yaml" ? "mcp-bridge-config.yaml" : "mcp-bridge-config.json";
    downloadTextFile(filename, raw, mime);
  } catch (err) {
    errorMessage.value = toErrorMessage(err, "Export failed.");
  } finally {
    exporting.value = false;
  }
}

async function runImport(dryRun: boolean) {
  errorMessage.value = "";
  result.value = null;
  busy.value = true;
  try {
    resultKind.value = "import";
    const body =
      importFormat.value === "yaml"
        ? { dryRun, format: "yaml", raw: importText.value }
        : { dryRun, data: JSON.parse(importText.value) };
    result.value = await api.post<ConfigImportResult>("/admin-api/config/import", body);
  } catch (err) {
    errorMessage.value =
      importFormat.value === "json" && err instanceof SyntaxError
        ? "Invalid JSON."
        : toErrorMessage(err, "Import failed.");
  } finally {
    busy.value = false;
  }
}

function requestImport() {
  requestImportConfirm(true);
}

async function confirmImport() {
  await confirmImportAction(async () => {
    await runImport(false);
  });
}
</script>

<template>
  <section>
    <PageHeader
      title="Configuration"
      subtitle="Export a portable snapshot of admin-authored config (bundles, alerts, per-client guards & overrides), or import one into this instance."
    />

    <div class="block">
      <h2>Export</h2>
      <div class="actions">
        <label for="export-format">Format</label>
        <select id="export-format" v-model="exportFormat">
          <option value="json">JSON</option>
          <option value="yaml">YAML</option>
        </select>
        <button type="button" class="btn-primary" :disabled="exporting" @click="doExport">
          {{ exporting ? "Exporting…" : `Download config .${exportFormat}` }}
        </button>
      </div>
    </div>

    <div class="block">
      <h2>Import</h2>
      <p class="hint">
        Paste an exported document (policy-as-code — includes guardrails and consumer quotas). Dry-run first to preview
        what would change — client/tool config only applies to already-registered servers.
      </p>
      <div class="actions">
        <label for="import-format">Format</label>
        <select id="import-format" v-model="importFormat">
          <option value="json">JSON</option>
          <option value="yaml">YAML</option>
        </select>
      </div>
      <label for="import-text">Import document</label>
      <textarea
        id="import-text"
        v-model="importText"
        rows="10"
        spellcheck="false"
        :placeholder="importFormat === 'yaml' ? 'version: 1' : jsonPlaceholder"
      ></textarea>
      <div class="actions">
        <button type="button" class="btn-secondary" :disabled="busy" @click="runImport(true)">Dry run</button>
        <button type="button" class="btn-primary" :disabled="busy" @click="requestImport">Apply import</button>
      </div>
    </div>

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
      <div v-if="snapshots.length" class="table-scroll">
        <table class="snap-table">
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
        </table>
      </div>
      <p v-else-if="!snapshotsError" class="hint">
        No snapshots yet. A snapshot captures the full config -- bundles, guardrails, consumers, and more -- so you can
        compare or roll back later.
      </p>

      <div v-if="diff" class="diff">
        <h3>Diff: #{{ diff.from.id }} “{{ diff.from.label }}” → {{ diff.to }}</h3>
        <p v-if="diff.entries.length === 0" class="hint">No differences.</p>
        <div v-else class="table-scroll">
          <table class="diff-table">
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
          </table>
        </div>
      </div>
    </div>

    <p v-if="errorMessage" class="error" role="alert">{{ errorMessage }}</p>

    <div v-if="result" class="result" :class="{ dry: result.dryRun }">
      <h3>
        {{
          result.dryRun
            ? "Dry run — nothing was changed"
            : resultKind === "rollback"
              ? "Rollback applied"
              : "Import applied"
        }}
      </h3>
      <ul>
        <li>Bundles: {{ result.applied.bundles }}</li>
        <li>Alert rules: {{ result.applied.alertRules }}</li>
        <li>Clients configured: {{ result.applied.clientsConfigured }}</li>
        <li>Tools configured: {{ result.applied.toolsConfigured }}</li>
        <li>Guardrails: {{ result.applied.guardrails }}</li>
        <li>Consumers: {{ result.applied.consumers }}</li>
      </ul>
      <div v-if="result.skipped.length" class="skipped">
        <strong>Skipped ({{ result.skipped.length }}):</strong>
        <ul>
          <li v-for="(s, i) in result.skipped" :key="i">
            {{ s.type }} <code>{{ s.id }}</code> — {{ s.reason }}
          </li>
        </ul>
      </div>
    </div>

    <ConfirmDialog
      :open="pendingImportConfirm !== null"
      title="Apply this import?"
      message="This overwrites bundles, alert rules, and per-client/tool configuration on already-registered servers with the contents of the pasted document. This cannot be undone from here."
      confirm-label="Apply import"
      danger
      @confirm="confirmImport"
      @cancel="cancelImportConfirm"
    />

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
  </section>
</template>

<style scoped>
/* PageHeader's own recipe covers color/margin; this page's subtitle is long
   enough to need a line-length cap that the shared component doesn't set. */
:deep(.subtitle) {
  max-width: 40rem;
}
.hint {
  color: var(--text-secondary);
  font-size: 0.85rem;
  max-width: 40rem;
}
.block {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-xs);
  padding: 1.25rem;
  margin: 1.25rem 0;
}
.block h2 {
  margin-top: 0;
  font-size: 1.05rem;
}
.block > label {
  display: block;
  font-size: 0.85rem;
  font-weight: 600;
  margin: 0.5rem 0 0.35rem;
}
textarea {
  width: 100%;
  box-sizing: border-box;
  font-family: var(--font-mono);
  font-size: 0.82rem;
  padding: 0.6rem;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
}
.actions {
  display: flex;
  gap: 0.75rem;
  margin-top: 0.75rem;
  align-items: center;
}
.actions label {
  font-size: 0.85rem;
  font-weight: 600;
}
.result {
  border-radius: var(--radius-md);
  padding: 1rem 1.25rem;
  background: var(--ok-soft);
  border: 1px solid var(--ok);
}
.result.dry {
  background: var(--signal-soft);
  border-color: var(--signal);
}
.result h3 {
  margin-top: 0;
}
.skipped {
  margin-top: 0.75rem;
  font-size: 0.85rem;
}
.label-input {
  padding: 0.45rem 0.6rem;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  font-size: 0.9rem;
  font-family: var(--font-body);
  min-width: 16.25rem;
}
.snap-table,
.diff-table {
  width: 100%;
  border-collapse: collapse;
  margin-top: 0.8rem;
  font-size: 0.85rem;
}
.snap-table th,
.diff-table th {
  text-align: left;
  padding: 0.4rem 0.5rem;
  border-bottom: 1px solid var(--border);
  color: var(--text-muted);
  font-size: 0.7rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  vertical-align: top;
}
.snap-table td,
.diff-table td {
  text-align: left;
  padding: 0.4rem 0.5rem;
  border-bottom: 1px solid var(--border);
  vertical-align: top;
}
.row-actions {
  display: flex;
  gap: 0.6rem;
  flex-wrap: wrap;
}
.diff {
  margin-top: 1rem;
}
.diff-table tr.added td {
  background: var(--ok-soft);
}
.diff-table tr.removed td {
  background: var(--breach-soft);
}
.diff-table tr.changed td {
  background: var(--canary-soft);
}
</style>
