<script setup lang="ts">
import { ref, computed } from "vue";
import { usePatchTool } from "@/composables/usePatchTool";
import { useFlash } from "@/composables/useFlash";
import { usePropDraft } from "@/composables/useFieldDraft";
import SaveRow from "@/components/ui/SaveRow.vue";
import { numberRangeValidator } from "@/utils/fieldParsing";

const props = defineProps<{
  approval?: { required: boolean; requiredLevels: number };
  clientName?: string;
  toolName?: string;
}>();
const emit = defineEmits<{ saved: [] }>();

const approvalRequiredInput = usePropDraft(() => props.approval?.required ?? false);
const approvalLevelsInput = usePropDraft(() => (props.approval?.requiredLevels ?? 1).toString());
const saved = ref(false);

const approvalLevelsError = computed(() =>
  numberRangeValidator({ integer: true, min: 1, max: 10, message: "Must be a whole number between 1 and 10" })(
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
    "Failed to save approval settings.",
  );
  if (ok) {
    flash(saved);
    emit("saved");
  }
}
</script>

<template>
  <h3>Human-in-the-loop approval</h3>
  <div class="field">
    <label class="checkline"
      ><input v-model="approvalRequiredInput" type="checkbox" /> Require human approval before this tool runs</label
    >
    <label for="approval-levels">Distinct approvers required</label>
    <p class="hint">
      A call is only allowed once this many DIFFERENT admins/operators have approved it (1 = today's single-approval
      behavior). Any single rejection blocks the call immediately, regardless of prior approvals.
    </p>
    <input
      id="approval-levels"
      v-model="approvalLevelsInput"
      type="text"
      inputmode="numeric"
      :disabled="!approvalRequiredInput"
    />
    <p v-if="approvalRequiredInput && approvalLevelsError" class="field-error">{{ approvalLevelsError }}</p>
    <SaveRow label="Save approval settings" :saving="saving" :saved="saved" :error="error" @save="saveApprovalFn" />
  </div>
</template>
