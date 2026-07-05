<script setup lang="ts">
import { ref } from "vue";
import { useI18n } from "vue-i18n";
import { api } from "@/composables/useApi";
import { useConfirmAction } from "@/composables/useConfirmAction";
import { toErrorMessage } from "@/utils/errors";
import { tk } from "@/i18n";
import type { ConfigImportResult } from "@/types/api";
import ConfirmDialog from "@/components/ui/ConfirmDialog.vue";
import FormField from "@/components/ui/FormField.vue";
import SelectMenu from "@/components/ui/SelectMenu.vue";

const emit = defineEmits<{ result: [result: ConfigImportResult | null]; error: [message: string] }>();
const { t } = useI18n({ useScope: "global" });

const FORMAT_OPTIONS: { value: "json" | "yaml"; label: string }[] = [
  { value: "json", label: "JSON" },
  { value: "yaml", label: "YAML" },
];

const importText = ref("");
const importFormat = ref<"json" | "yaml">("json");
const jsonPlaceholder = '{ "version": 1, ... }';
const busy = ref(false);
const {
  pending: pendingImportConfirm,
  request: requestImportConfirm,
  cancel: cancelImportConfirm,
  confirm: confirmImportAction,
} = useConfirmAction<true>();

async function runImport(dryRun: boolean) {
  emit("error", "");
  emit("result", null);
  busy.value = true;
  try {
    const body =
      importFormat.value === "yaml"
        ? { dryRun, format: "yaml", raw: importText.value }
        : { dryRun, data: JSON.parse(importText.value) };
    emit("result", await api.post<ConfigImportResult>("/admin-api/config/import", body));
  } catch (err) {
    emit(
      "error",
      importFormat.value === "json" && err instanceof SyntaxError
        ? t("components.config_import.errors.invalid_json")
        : toErrorMessage(err, tk("components.config_import.errors.import_failed")),
    );
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
  <div class="block">
    <h2>{{ t('components.config_import.title') }}</h2>
    <p class="hint">
      {{ t('components.config_import.hint') }}
    </p>
    <FormField class="format-field" :label="t('components.config_import.fields.format')" for="import-format">
      <SelectMenu id="import-format" v-model="importFormat" :options="FORMAT_OPTIONS" />
    </FormField>
    <label for="import-text">{{ t('components.config_import.fields.document') }}</label>
    <textarea
      id="import-text"
      v-model="importText"
      rows="10"
      spellcheck="false"
      :placeholder="importFormat === 'yaml' ? 'version: 1' : jsonPlaceholder"
    ></textarea>
    <div class="actions">
      <button type="button" class="btn-secondary" :disabled="busy" @click="runImport(true)">{{ t('components.config_import.dry_run') }}</button>
      <button type="button" class="btn-primary" :disabled="busy" @click="requestImport">{{ t('components.config_import.apply') }}</button>
    </div>
  </div>

  <ConfirmDialog
    :open="pendingImportConfirm !== null"
    :title="t('components.config_import.confirm.title')"
    :message="t('components.config_import.confirm.message')"
    :confirm-label="t('components.config_import.confirm.cta')"
    danger
    @confirm="confirmImport"
    @cancel="cancelImportConfirm"
  />
</template>