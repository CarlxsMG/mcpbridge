<script setup lang="ts">
import { ref } from "vue";
import { api } from "@/composables/useApi";
import { toErrorMessage } from "@/utils/errors";
import { downloadTextFile } from "@/utils/download";

const emit = defineEmits<{ error: [message: string] }>();

const exportingFormat = ref<"json" | "yaml" | null>(null);

async function doExport(format: "json" | "yaml") {
  exportingFormat.value = format;
  emit("error", "");
  try {
    // Formatting/parsing happens server-side — the admin UI never needs its
    // own YAML dependency, it just relays the raw text the backend produced.
    const suffix = format === "yaml" ? "?format=yaml" : "";
    const raw = await api.getRaw(`/admin-api/config/export${suffix}`);
    const mime = format === "yaml" ? "application/yaml" : "application/json";
    const filename = format === "yaml" ? "mcp-bridge-config.yaml" : "mcp-bridge-config.json";
    downloadTextFile(filename, raw, mime);
  } catch (err) {
    emit("error", toErrorMessage(err, "Export failed."));
  } finally {
    exportingFormat.value = null;
  }
}
</script>

<template>
  <div class="block">
    <h2>Export</h2>
    <div class="actions" role="group" aria-label="Export format">
      <button type="button" class="btn-secondary" :disabled="exportingFormat !== null" @click="doExport('json')">
        {{ exportingFormat === "json" ? "Exporting…" : "Download config .json" }}
      </button>
      <button type="button" class="btn-secondary" :disabled="exportingFormat !== null" @click="doExport('yaml')">
        {{ exportingFormat === "yaml" ? "Exporting…" : "Download config .yaml" }}
      </button>
    </div>
  </div>
</template>
