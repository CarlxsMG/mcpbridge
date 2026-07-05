<script setup lang="ts">
import { ref } from "vue";
import { useI18n } from "vue-i18n";
import { usePatchTool } from "@/composables/usePatchTool";
import { useFlash } from "@/composables/useFlash";
import { usePropDraft } from "@/composables/useFieldDraft";
import SaveRow from "@/components/ui/SaveRow.vue";
import { tk } from "@/i18n";

const props = defineProps<{ coalesce?: { enabled: boolean }; clientName?: string; toolName?: string }>();
const emit = defineEmits<{ saved: [] }>();
const { t } = useI18n({ useScope: "global" });

const coalesceInput = usePropDraft(() => props.coalesce?.enabled ?? false);
const saved = ref(false);

const { saving, error, patchField } = usePatchTool(
  () => props.clientName ?? "",
  () => props.toolName,
);
const { flash } = useFlash();

async function saveCoalesceFn() {
  const ok = await patchField("coalesce", coalesceInput.value ? { enabled: true } : null, tk("components.guard_editor_coalesce.errors.save_failed"));
  if (ok) {
    flash(saved);
    emit("saved");
  }
}
</script>

<template>
  <h3>{{ t('components.guard_editor_coalesce.title') }}</h3>
  <div class="field">
    <label class="checkline"
      ><input v-model="coalesceInput" type="checkbox" /> {{ t('components.guard_editor_coalesce.label') }}</label
    >
    <p class="hint">
      {{ t('components.guard_editor_coalesce.hint') }}
    </p>
    <SaveRow :label="t('components.guard_editor_coalesce.save')" :saving="saving" :saved="saved" :error="error" @save="saveCoalesceFn" />
  </div>
</template>