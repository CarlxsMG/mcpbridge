<script setup lang="ts">
import { ref } from "vue";
import { useI18n } from "vue-i18n";
import { usePatchTool } from "@/composables/usePatchTool";
import { useFlash } from "@/composables/useFlash";
import { usePropDraft } from "@/composables/useFieldDraft";
import SaveRow from "@/components/ui/SaveRow.vue";
import { parseList } from "@/utils/fieldParsing";
import { tk } from "@/i18n";

const props = defineProps<{ redactPaths?: string[]; clientName?: string; toolName?: string }>();
const emit = defineEmits<{ saved: [] }>();
const { t } = useI18n({ useScope: "global" });

const redactInput = usePropDraft(() => (props.redactPaths ?? []).join("\n"));
const saved = ref(false);

const { saving, error, patchField } = usePatchTool(
  () => props.clientName ?? "",
  () => props.toolName,
);
const { flash } = useFlash();

async function saveRedactionFn() {
  const paths = parseList(redactInput.value, /[\n,]/);
  const ok = await patchField("redactPaths", paths, tk("components.guard_editor_redaction.errors.save_failed"));
  if (ok) {
    flash(saved);
    emit("saved");
  }
}
</script>

<template>
  <h3>{{ t('components.guard_editor_redaction.title') }}</h3>
  <div class="field">
    <label for="tool-redact">{{ t('components.guard_editor_redaction.label') }}</label>
    <p class="hint">
      {{ t('components.guard_editor_redaction.hint') }}
    </p>
    <textarea id="tool-redact" v-model="redactInput" rows="3" :placeholder="t('components.guard_editor_redaction.placeholder')"></textarea>
    <SaveRow :label="t('components.guard_editor_redaction.save')" :saving="saving" :saved="saved" :error="error" @save="saveRedactionFn" />
  </div>
</template>