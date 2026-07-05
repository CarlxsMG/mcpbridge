<script setup lang="ts">
import { ref, computed } from "vue";
import { useI18n } from "vue-i18n";
import { usePatchTool } from "@/composables/usePatchTool";
import { useFlash } from "@/composables/useFlash";
import { usePropDraft } from "@/composables/useFieldDraft";
import SaveRow from "@/components/ui/SaveRow.vue";
import { numberRangeValidator } from "@/utils/fieldParsing";
import { tk } from "@/i18n";

const props = defineProps<{
  approval?: { required: boolean; requiredLevels: number };
  clientName?: string;
  toolName?: string;
}>();
const emit = defineEmits<{ saved: [] }>();
const { t } = useI18n({ useScope: "global" });

const approvalRequiredInput = usePropDraft(() => props.approval?.required ?? false);
const approvalLevelsInput = usePropDraft(() => (props.approval?.requiredLevels ?? 1).toString());
const saved = ref(false);

const approvalLevelsError = computed(() =>
  numberRangeValidator({ integer: true, min: 1, max: 10, message: t("components.guard_editor_approval.levels_error") })(
    approvalLevelsInput.value,
  ),
);

const { saving, error, patchFields } = usePatchTool(
  () => props.clientName ?? "",
  () => props.toolName,
);
const { flash } = useFlash();

async function saveApprovalFn() {
  if (approvalLevelsError.value) return;
  const ok = await patchFields(
    { requiresApproval: approvalRequiredInput.value, approvalLevels: Number(approvalLevelsInput.value) },
    tk("components.guard_editor_approval.errors.save_failed"),
  );
  if (ok) {
    flash(saved);
    emit("saved");
  }
}
</script>

<template>
  <h3>{{ t('components.guard_editor_approval.title') }}</h3>
  <div class="field">
    <label class="checkline"
      ><input v-model="approvalRequiredInput" type="checkbox" /> {{ t('components.guard_editor_approval.require_label') }}</label
    >
    <label for="approval-levels">{{ t('components.guard_editor_approval.levels_label') }}</label>
    <p class="hint">
      {{ t('components.guard_editor_approval.levels_hint') }}
    </p>
    <input
      id="approval-levels"
      v-model="approvalLevelsInput"
      type="text"
      inputmode="numeric"
      :disabled="!approvalRequiredInput"
    />
    <p v-if="approvalRequiredInput && approvalLevelsError" class="field-error">{{ approvalLevelsError }}</p>
    <SaveRow :label="t('components.guard_editor_approval.save')" :saving="saving" :saved="saved" :error="error" @save="saveApprovalFn" />
  </div>
</template>