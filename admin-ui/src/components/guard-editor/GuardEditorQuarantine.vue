<script setup lang="ts">
import { ref, computed } from "vue";
import { usePatchTool } from "@/composables/usePatchTool";
import { useFlash } from "@/composables/useFlash";
import { usePropDraft } from "@/composables/useDraftField";
import SaveRow from "@/components/ui/SaveRow.vue";
import SelectMenu from "@/components/ui/SelectMenu.vue";
import { numberRangeValidator } from "@/utils/fieldParsing";

const ACTION_OPTIONS: { value: "block" | "force_approval" | "observe"; label: string }[] = [
  { value: "block", label: "Block calls (same as disabling the tool)" },
  { value: "force_approval", label: "Force every call through human approval" },
  { value: "observe", label: "Observe only — log and let calls through" },
];
const RECOVERY_OPTIONS: { value: "auto" | "manual"; label: string }[] = [
  { value: "manual", label: "Manual only — an admin must clear it" },
  { value: "auto", label: "Automatic — clears itself after a cooldown" },
];

const props = defineProps<{
  quarantine?: {
    policy: {
      consecutiveThreshold: number;
      action: "block" | "force_approval" | "observe";
      recoveryMode: "auto" | "manual";
      cooldownMs: number | null;
    };
    state: {
      quarantined: boolean;
      consecutiveHits: number;
      quarantinedAt: number | null;
      reason: string | null;
      cooldownUntil: number | null;
    };
  };
  clientName?: string;
  toolName?: string;
}>();
const emit = defineEmits<{ saved: [] }>();

const quarantineEnabledInput = usePropDraft(() => Boolean(props.quarantine));
const quarantineThresholdInput = usePropDraft(() => (props.quarantine?.policy.consecutiveThreshold ?? 3).toString());
const quarantineActionInput = usePropDraft(() => props.quarantine?.policy.action ?? "block");
const quarantineRecoveryInput = usePropDraft(() => props.quarantine?.policy.recoveryMode ?? "manual");
const quarantineCooldownInput = usePropDraft(() =>
  props.quarantine?.policy.cooldownMs ? (props.quarantine.policy.cooldownMs / 60_000).toString() : "",
);
const saved = ref(false);
const clearedSaved = ref(false);

const quarantineThresholdError = computed(() =>
  numberRangeValidator({ integer: true, min: 1, max: 100, message: "Must be a whole number between 1 and 100" })(
    quarantineThresholdInput.value,
  ),
);

const quarantineCooldownError = computed(() => {
  if (quarantineRecoveryInput.value !== "auto") return null;
  if (!quarantineCooldownInput.value.trim()) return "Required when recovery is automatic";
  // Number.MIN_VALUE is the smallest representable positive number, so an
  // inclusive min of it is equivalent to the original's strict `n > 0` check.
  return numberRangeValidator({ min: Number.MIN_VALUE, message: "Must be a positive number of minutes" })(
    quarantineCooldownInput.value,
  );
});

const { saving, error, patchField, clearQuarantine } = usePatchTool(
  () => props.clientName ?? "",
  () => props.toolName,
);
const { flash } = useFlash();
const clearing = ref(false);

async function saveQuarantineFn() {
  if (!quarantineEnabledInput.value) {
    const ok = await patchField("quarantinePolicy", null, "Failed to save quarantine settings.");
    if (ok) {
      flash(saved);
      emit("saved");
    }
    return;
  }
  if (quarantineThresholdError.value || quarantineCooldownError.value) return;
  const ok = await patchField(
    "quarantinePolicy",
    {
      consecutiveThreshold: Number(quarantineThresholdInput.value),
      action: quarantineActionInput.value,
      recoveryMode: quarantineRecoveryInput.value,
      cooldownMs:
        quarantineRecoveryInput.value === "auto" ? Math.round(Number(quarantineCooldownInput.value) * 60_000) : null,
    },
    "Failed to save quarantine settings.",
  );
  if (ok) {
    flash(saved);
    emit("saved");
  }
}

async function clearQuarantineFn() {
  clearing.value = true;
  const ok = await clearQuarantine("Failed to clear quarantine.");
  clearing.value = false;
  if (ok) {
    flash(clearedSaved);
    emit("saved");
  }
}
</script>

<template>
  <h3>Auto-quarantine</h3>
  <div class="field">
    <div v-if="quarantine?.state.quarantined" class="quarantine-banner">
      Currently quarantined{{ quarantine.state.reason ? `: ${quarantine.state.reason}` : "" }}
      <button type="button" class="link-btn" :disabled="saving" @click="clearQuarantineFn">
        {{ clearing ? "Clearing…" : "Clear now" }}
      </button>
    </div>
    <label class="checkline"
      ><input v-model="quarantineEnabledInput" type="checkbox" /> Auto-quarantine after repeated guardrail
      violations</label
    >
    <template v-if="quarantineEnabledInput">
      <label for="q-threshold">Consecutive violations before quarantine</label>
      <input id="q-threshold" v-model="quarantineThresholdInput" type="text" inputmode="numeric" />
      <p v-if="quarantineThresholdError" class="field-error">{{ quarantineThresholdError }}</p>

      <label for="q-action">Action when quarantined</label>
      <SelectMenu id="q-action" v-model="quarantineActionInput" :options="ACTION_OPTIONS" />

      <label for="q-recovery">Recovery</label>
      <SelectMenu id="q-recovery" v-model="quarantineRecoveryInput" :options="RECOVERY_OPTIONS" />

      <template v-if="quarantineRecoveryInput === 'auto'">
        <label for="q-cooldown">Cooldown (minutes)</label>
        <input
          id="q-cooldown"
          v-model="quarantineCooldownInput"
          type="text"
          inputmode="decimal"
          placeholder="e.g. 15"
        />
        <p v-if="quarantineCooldownError" class="field-error">{{ quarantineCooldownError }}</p>
      </template>
    </template>
    <SaveRow label="Save quarantine settings" :saving="saving" :saved="saved" @save="saveQuarantineFn" />
    <span v-if="clearedSaved" class="save-ok">Cleared</span>
    <p v-if="error" class="field-error">{{ error }}</p>
  </div>
</template>
