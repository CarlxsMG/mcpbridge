<script setup lang="ts">
import { ref, watch } from "vue";
import { usePatchTool } from "../composables/usePatchTool";
import { useFlash } from "../composables/useFlash";
import { parseList } from "../composables/fieldParsing";

const props = defineProps<{ redactPaths?: string[]; clientName?: string; toolName?: string }>();
const emit = defineEmits<{ saved: [] }>();

const redactInput = ref((props.redactPaths ?? []).join("\n"));
const saved = ref(false);

watch(
  () => props.redactPaths,
  (p) => {
    redactInput.value = (p ?? []).join("\n");
  },
);

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
    <button type="button" class="btn-secondary desc-save" :disabled="saving" @click="saveRedactionFn">
      {{ saving ? "Saving…" : "Save redaction" }}
    </button>
    <span v-if="saved" class="save-ok">Saved</span>
    <p v-if="error" class="field-error">{{ error }}</p>
  </div>
</template>
