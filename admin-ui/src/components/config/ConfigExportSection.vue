<script setup lang="ts">
import { ref } from "vue";
import { useI18n } from "vue-i18n";
import { api } from "@/composables/useApi";
import { toErrorMessage } from "@/utils/errors";
import { downloadTextFile } from "@/utils/download";
import { tk } from "@/i18n";

const emit = defineEmits<{ error: [message: string] }>();
const { t } = useI18n({ useScope: "global" });

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
    emit("error", toErrorMessage(err, tk("components.config_export.errors.export_failed")));
  } finally {
    exportingFormat.value = null;
  }
}
</script>

<template>
  <div class="config-block">
    <h2>{{ t("components.config_export.title") }}</h2>
    <div class="actions" role="group" :aria-label="t('components.config_export.aria_label')">
      <button type="button" class="btn-secondary" :disabled="exportingFormat !== null" @click="doExport('json')">
        {{
          exportingFormat === "json"
            ? t("components.config_export.exporting")
            : t("components.config_export.download_json")
        }}
      </button>
      <button type="button" class="btn-secondary" :disabled="exportingFormat !== null" @click="doExport('yaml')">
        {{
          exportingFormat === "yaml"
            ? t("components.config_export.exporting")
            : t("components.config_export.download_yaml")
        }}
      </button>
    </div>
  </div>
</template>
