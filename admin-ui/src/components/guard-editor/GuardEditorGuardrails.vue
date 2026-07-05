<script setup lang="ts">
import { ref } from "vue";
import { useI18n } from "vue-i18n";
import { usePatchTool } from "@/composables/usePatchTool";
import { useFlash } from "@/composables/useFlash";
import { usePropDraft } from "@/composables/useFieldDraft";
import SaveRow from "@/components/ui/SaveRow.vue";
import { parseList } from "@/utils/fieldParsing";
import { ShieldCheck } from "lucide-vue-next";
import { tk } from "@/i18n";

const props = defineProps<{
  guardrails?: { denyPatterns: string[]; blockSecrets: boolean; scanResponses: boolean };
  clientName?: string;
  toolName?: string;
}>();
const emit = defineEmits<{ saved: [] }>();
const { t } = useI18n({ useScope: "global" });

const denyPatternsInput = usePropDraft(() => (props.guardrails?.denyPatterns ?? []).join("\n"));
const blockSecretsInput = usePropDraft(() => props.guardrails?.blockSecrets ?? false);
const scanResponsesInput = usePropDraft(() => props.guardrails?.scanResponses ?? false);
const saved = ref(false);

const { saving, error, patchField } = usePatchTool(
  () => props.clientName ?? "",
  () => props.toolName,
);
const { flash } = useFlash();

async function saveGuardrailsFn() {
  const denyPatterns = parseList(denyPatternsInput.value, "\n");
  const payload =
    denyPatterns.length === 0 && !blockSecretsInput.value && !scanResponsesInput.value
      ? null
      : { denyPatterns, blockSecrets: blockSecretsInput.value, scanResponses: scanResponsesInput.value };
  const ok = await patchField("guardrails", payload, tk("components.guard_editor_guardrails.errors.save_failed"));
  if (ok) {
    flash(saved);
    emit("saved");
  }
}
</script>

<template>
  <h3>
    <ShieldCheck :size="15" stroke-width="2" aria-hidden="true" /> {{ t("components.guard_editor_guardrails.title") }}
  </h3>
  <div class="field">
    <label for="tool-deny">{{ t("components.guard_editor_guardrails.content_label") }}</label>
    <p class="hint">
      {{ t("components.guard_editor_guardrails.content_hint") }}
    </p>
    <textarea
      id="tool-deny"
      v-model="denyPatternsInput"
      rows="2"
      placeholder="\bDROP\s+TABLE\b&#10;rm\s+-rf"
    ></textarea>
    <label class="checkline"
      ><input v-model="blockSecretsInput" type="checkbox" />
      {{ t("components.guard_editor_guardrails.block_secrets") }}</label
    >
    <label class="checkline"
      ><input v-model="scanResponsesInput" type="checkbox" />
      {{ t("components.guard_editor_guardrails.scan_responses") }}</label
    >
    <SaveRow
      :label="t('components.guard_editor_guardrails.save')"
      :saving="saving"
      :saved="saved"
      :error="error"
      @save="saveGuardrailsFn"
    />
  </div>
</template>
