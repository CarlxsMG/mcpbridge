<script setup lang="ts">
import { ref } from "vue";
import { usePatchTool } from "@/composables/usePatchTool";
import { useFlash } from "@/composables/useFlash";
import { usePropDraft } from "@/composables/useDraftField";
import SaveRow from "@/components/ui/SaveRow.vue";
import { parseList } from "@/utils/fieldParsing";
import { ShieldCheck } from "lucide-vue-next";

const props = defineProps<{
  guardrails?: { denyPatterns: string[]; blockSecrets: boolean; scanResponses: boolean };
  clientName?: string;
  toolName?: string;
}>();
const emit = defineEmits<{ saved: [] }>();

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
  const ok = await patchField("guardrails", payload, "Failed to save guardrails.");
  if (ok) {
    flash(saved);
    emit("saved");
  }
}
</script>

<template>
  <h3><ShieldCheck :size="15" stroke-width="2" aria-hidden="true" /> Guardrails</h3>
  <div class="field">
    <label for="tool-deny">Content guardrails</label>
    <p class="hint">
      Input deny patterns (one regex per line). A call whose arguments match any pattern is rejected before dispatch.
    </p>
    <textarea
      id="tool-deny"
      v-model="denyPatternsInput"
      rows="2"
      placeholder="\bDROP\s+TABLE\b&#10;rm\s+-rf"
    ></textarea>
    <label class="checkline"
      ><input v-model="blockSecretsInput" type="checkbox" /> Block arguments that look like secrets (AWS keys, private
      keys, tokens…)</label
    >
    <label class="checkline"
      ><input v-model="scanResponsesInput" type="checkbox" /> Scan responses for prompt-injection and wrap flagged
      output</label
    >
    <SaveRow label="Save guardrails" :saving="saving" :saved="saved" :error="error" @save="saveGuardrailsFn" />
  </div>
</template>
