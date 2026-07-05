<script setup lang="ts">
import { ref } from "vue";
import { usePatchTool } from "@/composables/usePatchTool";
import { useFlash } from "@/composables/useFlash";
import { usePropDraft } from "@/composables/useFieldDraft";
import SaveRow from "@/components/ui/SaveRow.vue";

const props = defineProps<{ coalesce?: { enabled: boolean }; clientName?: string; toolName?: string }>();
const emit = defineEmits<{ saved: [] }>();

const coalesceInput = usePropDraft(() => props.coalesce?.enabled ?? false);
const saved = ref(false);

const { saving, error, patchField } = usePatchTool(
  () => props.clientName ?? "",
  () => props.toolName,
);
const { flash } = useFlash();

async function saveCoalesceFn() {
  const ok = await patchField("coalesce", coalesceInput.value ? { enabled: true } : null, "Failed to save coalescing.");
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
      ><input v-model="coalesceInput" type="checkbox" /> Share one upstream fetch across concurrent identical calls (GET
      tools only)</label
    >
    <p class="hint">
      Distinct from the response cache's TTL — only dedupes calls that are in flight at the same moment, so it's safe
      even without caching enabled.
    </p>
    <SaveRow label="Save coalescing" :saving="saving" :saved="saved" :error="error" @save="saveCoalesceFn" />
  </div>
</template>
