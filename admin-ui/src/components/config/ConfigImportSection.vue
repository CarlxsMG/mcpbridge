<script setup lang="ts">
import { ref } from "vue";
import { api } from "@/composables/useApi";
import { useConfirmAction } from "@/composables/useConfirmAction";
import { toErrorMessage } from "@/utils/errors";
import type { ConfigImportResult } from "@/types/api";
import ConfirmDialog from "@/components/ui/ConfirmDialog.vue";
import FormField from "@/components/ui/FormField.vue";
import SelectMenu from "@/components/ui/SelectMenu.vue";

const emit = defineEmits<{ result: [result: ConfigImportResult | null]; error: [message: string] }>();

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
        ? "Invalid JSON."
        : toErrorMessage(err, "Import failed."),
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
    <h2>Import</h2>
    <p class="hint">
      Paste an exported document (policy-as-code — includes guardrails and consumer quotas). Dry-run first to preview
      what would change — client/tool config only applies to already-registered servers.
    </p>
    <FormField class="format-field" label="Format" for="import-format">
      <SelectMenu id="import-format" v-model="importFormat" :options="FORMAT_OPTIONS" />
    </FormField>
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

  <ConfirmDialog
    :open="pendingImportConfirm !== null"
    title="Apply this import?"
    message="This overwrites bundles, alert rules, and per-client/tool configuration on already-registered servers with the contents of the pasted document. This cannot be undone from here."
    confirm-label="Apply import"
    danger
    @confirm="confirmImport"
    @cancel="cancelImportConfirm"
  />
</template>
