<script setup lang="ts">
import { ref } from "vue";
import { api, ApiError } from "../composables/useApi";
import type { ConfigImportResult } from "../types/api";

const exporting = ref(false);
const importText = ref("");
const result = ref<ConfigImportResult | null>(null);
const busy = ref(false);
const errorMessage = ref("");

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
</style>
