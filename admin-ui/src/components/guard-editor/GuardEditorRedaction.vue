<script setup lang="ts">
import { ref } from "vue";
import { usePatchTool } from "@/composables/usePatchTool";
import { useFlash } from "@/composables/useFlash";
import { usePropDraft } from "@/composables/useDraftField";
import SaveRow from "@/components/ui/SaveRow.vue";
import { parseList } from "@/utils/fieldParsing";

const props = defineProps<{ redactPaths?: string[]; clientName?: string; toolName?: string }>();
const emit = defineEmits<{ saved: [] }>();

const redactInput = usePropDraft(() => (props.redactPaths ?? []).join("\n"));
const saved = ref(false);

const { saving, error, patchField } = usePatchTool(
  () => props.clientName ?? "",
  () => props.toolName,
);
const { flash } = useFlash();

async function saveRedactionFn() {
  const paths = parseList(redactInput.value, /[\n,]/);
  const ok = await patchField("redactPaths", paths, "Failed to save redaction paths.");
  if (ok) {
    flash(saved);
    emit("saved");
  }
}
</script>

<template>
  <h3>Redaction</h3>
  <div class="field">
    <label for="tool-redact">Response redaction paths</label>
    <p class="hint">
      One dot-path per line (e.g. user.ssn, items.*.secret). Matching JSON values are replaced with [REDACTED] before
      returning to the caller.
    </p>
    <textarea id="tool-redact" v-model="redactInput" rows="3" placeholder="user.password&#10;items.*.token"></textarea>
    <SaveRow label="Save redaction" :saving="saving" :saved="saved" :error="error" @save="saveRedactionFn" />
  </div>
</template>
