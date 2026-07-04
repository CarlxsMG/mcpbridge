<script setup lang="ts">
import { ref, watch } from "vue";
import { usePatchTool } from "@/composables/usePatchTool";
import { useFlash } from "@/composables/useFlash";

const props = defineProps<{ coalesce?: { enabled: boolean }; clientName?: string; toolName?: string }>();
const emit = defineEmits<{ saved: [] }>();

const coalesceInput = ref(props.coalesce?.enabled ?? false);
const saved = ref(false);

watch(
  () => props.coalesce,
  (c) => {
    coalesceInput.value = c?.enabled ?? false;
  },
);

const { saving, error, patchField } = usePatchTool(
  () => props.clientName ?? "",
  () => props.toolName,
);
const { flash } = useFlash();

async function saveCoalesceFn() {
  const ok = await patchField(
    "coalesce",
    coalesceInput.value ? { enabled: true } : null,
    "Failed to save coalescing.",
  );
  if (ok) {
    flash(saved);
    emit("saved");
  }
}
</script>

<template>
  <h3>Request coalescing</h3>
  <div class="field">
    <label class="checkline"
      ><input v-model="coalesceInput" type="checkbox" /> Share one upstream fetch across concurrent identical calls
      (GET tools only)</label
    >
    <p class="hint">
      Distinct from the response cache's TTL — only dedupes calls that are in flight at the same moment, so it's safe
      even without caching enabled.
    </p>
    <button type="button" class="btn-secondary desc-save" :disabled="saving" @click="saveCoalesceFn">
      {{ saving ? "Saving…" : "Save coalescing" }}
    </button>
    <span v-if="saved" class="save-ok">Saved</span>
    <p v-if="error" class="field-error">{{ error }}</p>
  </div>
</template>
