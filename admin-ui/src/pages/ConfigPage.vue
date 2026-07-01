<script setup lang="ts">
import { ref, onMounted } from "vue";
import { api, ApiError } from "../composables/useApi";
import type { ConfigImportResult, ConfigSnapshotSummary, ConfigDiffResult } from "../types/api";

const exporting = ref(false);
const importText = ref("");
const result = ref<ConfigImportResult | null>(null);
const busy = ref(false);
const errorMessage = ref("");

// Version history
const snapshots = ref<ConfigSnapshotSummary[]>([]);
const newSnapshotLabel = ref("");
const snapshotBusy = ref(false);
const diff = ref<ConfigDiffResult | null>(null);

async function loadSnapshots() {
  try {
    const res = await api.get<{ items: ConfigSnapshotSummary[] }>("/admin-api/config/snapshots");
    snapshots.value = res.items;
  } catch {
    /* ignore */
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
    errorMessage.value = err instanceof ApiError ? err.message : "Failed to create snapshot.";
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
    errorMessage.value = err instanceof ApiError ? err.message : "Failed to diff.";
  }
}

async function rollback(s: ConfigSnapshotSummary) {
  if (!confirm(`Roll back config to snapshot "${s.label}"? This re-applies it to existing servers.`)) return;
  snapshotBusy.value = true;
  errorMessage.value = "";
  try {
    result.value = await api.post<ConfigImportResult>(`/admin-api/config/snapshots/${s.id}/rollback`, {});
  } catch (err) {
    errorMessage.value = err instanceof ApiError ? err.message : "Rollback failed.";
  } finally {
    snapshotBusy.value = false;
  }
}

async function deleteSnapshot(s: ConfigSnapshotSummary) {
  if (!confirm(`Delete snapshot "${s.label}"?`)) return;
  try {
    await api.delete(`/admin-api/config/snapshots/${s.id}`);
    if (diff.value?.from.id === s.id) diff.value = null;
    await loadSnapshots();
  } catch (err) {
    errorMessage.value = err instanceof ApiError ? err.message : "Delete failed.";
  }
}

function fmt(v: unknown): string {
  if (v === undefined) return "—";
  return typeof v === "object" ? JSON.stringify(v) : String(v);
}

async function doExport() {
  exporting.value = true;
  errorMessage.value = "";
  try {
    const doc = await api.get<unknown>("/admin-api/config/export");
    const blob = new Blob([JSON.stringify(doc, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "mcp-bridge-config.json";
    a.click();
    URL.revokeObjectURL(url);
  } catch (err) {
    errorMessage.value = err instanceof ApiError ? err.message : "Export failed.";
  } finally {
    exporting.value = false;
  }
}

async function runImport(dryRun: boolean) {
  errorMessage.value = "";
  result.value = null;
  let data: unknown;
  try {
    data = JSON.parse(importText.value);
  } catch {
    errorMessage.value = "Invalid JSON.";
    return;
  }
  busy.value = true;
  try {
    result.value = await api.post<ConfigImportResult>("/admin-api/config/import", { dryRun, data });
  } catch (err) {
    errorMessage.value = err instanceof ApiError ? err.message : "Import failed.";
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <section>
    <h1>Configuration</h1>
    <p class="hint">Export a portable snapshot of admin-authored config (bundles, alerts, per-client guards & overrides), or import one into this instance.</p>

    <div class="block">
      <h2>Export</h2>
      <button type="button" class="btn-primary" :disabled="exporting" @click="doExport">
        {{ exporting ? "Exporting…" : "Download config JSON" }}
      </button>
    </div>

    <div class="block">
      <h2>Import</h2>
      <p class="hint">Paste an exported document. Dry-run first to preview what would change — client/tool config only applies to already-registered servers.</p>
      <textarea v-model="importText" rows="10" spellcheck="false" placeholder='{ "version": 1, ... }'></textarea>
      <div class="actions">
        <button type="button" class="btn-secondary" :disabled="busy" @click="runImport(true)">Dry run</button>
        <button type="button" class="btn-primary" :disabled="busy" @click="runImport(false)">Apply import</button>
      </div>
    </div>

    <div class="block">
      <h2>Version history</h2>
      <p class="hint">Snapshot the current config, diff a snapshot against the live config, or roll back to it.</p>
      <div class="actions">
        <input v-model="newSnapshotLabel" type="text" placeholder="Snapshot label (e.g. before-migration)" class="label-input" />
        <button type="button" class="btn-primary" :disabled="snapshotBusy || !newSnapshotLabel.trim()" @click="createSnapshotFn">Snapshot now</button>
      </div>
      <table v-if="snapshots.length" class="snap-table">
        <thead><tr><th>#</th><th>Label</th><th>Created</th><th>By</th><th></th></tr></thead>
        <tbody>
          <tr v-for="s in snapshots" :key="s.id">
            <td>{{ s.id }}</td>
            <td>{{ s.label }}</td>
            <td>{{ new Date(s.createdAt).toLocaleString() }}</td>
            <td>{{ s.createdBy }}</td>
            <td class="row-actions">
              <button type="button" class="link-btn" @click="showDiff(s)">diff vs current</button>
              <button type="button" class="link-btn" @click="rollback(s)">rollback</button>
              <button type="button" class="link-btn del" @click="deleteSnapshot(s)">delete</button>
            </td>
          </tr>
        </tbody>
      </table>
      <p v-else class="hint">No snapshots yet.</p>

      <div v-if="diff" class="diff">
        <h3>Diff: #{{ diff.from.id }} “{{ diff.from.label }}” → {{ diff.to }}</h3>
        <p v-if="diff.entries.length === 0" class="hint">No differences.</p>
        <table v-else class="diff-table">
          <thead><tr><th>Path</th><th>Change</th><th>Before</th><th>After</th></tr></thead>
          <tbody>
            <tr v-for="(e, i) in diff.entries" :key="i" :class="e.kind">
              <td><code>{{ e.path }}</code></td>
              <td>{{ e.kind }}</td>
              <td><code>{{ fmt(e.before) }}</code></td>
              <td><code>{{ fmt(e.after) }}</code></td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <p v-if="errorMessage" class="error" role="alert">{{ errorMessage }}</p>

    <div v-if="result" class="result" :class="{ dry: result.dryRun }">
      <h3>{{ result.dryRun ? "Dry run — nothing was changed" : "Import applied" }}</h3>
      <ul>
        <li>Bundles: {{ result.applied.bundles }}</li>
        <li>Alert rules: {{ result.applied.alertRules }}</li>
        <li>Clients configured: {{ result.applied.clientsConfigured }}</li>
        <li>Tools configured: {{ result.applied.toolsConfigured }}</li>
      </ul>
      <div v-if="result.skipped.length" class="skipped">
        <strong>Skipped ({{ result.skipped.length }}):</strong>
        <ul>
          <li v-for="(s, i) in result.skipped" :key="i">{{ s.type }} <code>{{ s.id }}</code> — {{ s.reason }}</li>
        </ul>
      </div>
    </div>
  </section>
</template>

<style scoped>
.hint {
  color: #63676e;
  font-size: 0.85rem;
  max-width: 640px;
}
.block {
  background: #fafbfc;
  border-radius: 8px;
  padding: 1.25rem;
  margin: 1.25rem 0;
}
.block h2 {
  margin-top: 0;
  font-size: 1.05rem;
}
textarea {
  width: 100%;
  box-sizing: border-box;
  font-family: ui-monospace, monospace;
  font-size: 0.82rem;
  padding: 0.6rem;
  border: 1px solid #cfd4da;
  border-radius: 6px;
}
.actions {
  display: flex;
  gap: 0.75rem;
  margin-top: 0.75rem;
}
.result {
  border-radius: 8px;
  padding: 1rem 1.25rem;
  background: #eef7ee;
  border: 1px solid #b7dcb7;
}
.result.dry {
  background: #eef2f7;
  border-color: #b7c6dc;
}
.result h3 {
  margin-top: 0;
}
.skipped {
  margin-top: 0.75rem;
  font-size: 0.85rem;
}
.error {
  color: #a11212;
}
.label-input {
  padding: 0.45rem 0.6rem;
  border: 1px solid #cfd4da;
  border-radius: 6px;
  font-size: 0.9rem;
  min-width: 260px;
}
.snap-table, .diff-table {
  width: 100%;
  border-collapse: collapse;
  margin-top: 0.8rem;
  font-size: 0.85rem;
}
.snap-table th, .snap-table td, .diff-table th, .diff-table td {
  text-align: left;
  padding: 0.4rem 0.5rem;
  border-bottom: 1px solid #e6e8eb;
  vertical-align: top;
}
.row-actions { display: flex; gap: 0.6rem; flex-wrap: wrap; }
.link-btn { background: none; border: none; color: #2a5db0; cursor: pointer; padding: 0; font-size: 0.85rem; }
.link-btn.del { color: #a11212; }
.diff { margin-top: 1rem; }
.diff-table tr.added td { background: #eef7ee; }
.diff-table tr.removed td { background: #fbeeee; }
.diff-table tr.changed td { background: #fdf6e3; }
</style>
