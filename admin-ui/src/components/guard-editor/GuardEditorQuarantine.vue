<script setup lang="ts">
import { ref, computed } from "vue";
import { useI18n } from "vue-i18n";
import { usePatchTool } from "@/composables/usePatchTool";
import { useFlash } from "@/composables/useFlash";
import { usePropDraft } from "@/composables/useFieldDraft";
import SaveRow from "@/components/ui/SaveRow.vue";
import SelectMenu from "@/components/ui/SelectMenu.vue";
import { numberRangeValidator } from "@/utils/fieldParsing";
import { tk } from "@/i18n";

const { t } = useI18n({ useScope: "global" });

const ACTION_OPTIONS: { value: "block" | "force_approval" | "observe"; label: string }[] = [
  { value: "block", label: t("components.guard_editor_quarantine.action.block") },
  { value: "force_approval", label: t("components.guard_editor_quarantine.action.force_approval") },
  { value: "observe", label: t("components.guard_editor_quarantine.action.observe") },
];
const RECOVERY_OPTIONS: { value: "auto" | "manual"; label: string }[] = [
  { value: "manual", label: t("components.guard_editor_quarantine.recovery.manual") },
  { value: "auto", label: t("components.guard_editor_quarantine.recovery.auto") },
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
  numberRangeValidator({
    integer: true,
    min: 1,
    max: 100,
    message: t("components.guard_editor_quarantine.threshold_error"),
  })(quarantineThresholdInput.value),
);

const quarantineCooldownError = computed(() => {
  if (quarantineRecoveryInput.value !== "auto") return null;
  if (!quarantineCooldownInput.value.trim()) return t("components.guard_editor_quarantine.cooldown_required");
  return numberRangeValidator({
    min: Number.MIN_VALUE,
    message: t("components.guard_editor_quarantine.cooldown_positive"),
  })(quarantineCooldownInput.value);
});

const { saving, error, patchField, clearQuarantine } = usePatchTool(
  () => props.clientName ?? "",
  () => props.toolName,
);
const { flash } = useFlash();
const clearing = ref(false);

async function saveQuarantineFn() {
  if (!quarantineEnabledInput.value) {
    const ok = await patchField("quarantinePolicy", null, tk("components.guard_editor_quarantine.errors.save_failed"));
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
    tk("components.guard_editor_quarantine.errors.save_failed"),
  );
  if (ok) {
    flash(saved);
    emit("saved");
  }
}

async function clearQuarantineFn() {
  clearing.value = true;
  const ok = await clearQuarantine(tk("components.guard_editor_quarantine.errors.clear_failed"));
  clearing.value = false;
  if (ok) {
    flash(clearedSaved);
    emit("saved");
  }
}
</script>

<template>
  <h3>{{ t("components.guard_editor_quarantine.title") }}</h3>
  <div class="field">
    <div v-if="quarantine?.state.quarantined" class="quarantine-banner">
      {{ t("components.guard_editor_quarantine.currently_quarantined")
      }}{{ quarantine.state.reason ? `: ${quarantine.state.reason}` : "" }}
      <button type="button" class="link-btn" :disabled="saving" @click="clearQuarantineFn">
        {{
          clearing
            ? t("components.guard_editor_quarantine.clearing")
            : t("components.guard_editor_quarantine.clear_now")
        }}
      </button>
    </div>
    <label class="checkline"
      ><input v-model="quarantineEnabledInput" type="checkbox" />
      {{ t("components.guard_editor_quarantine.enable_label") }}</label
    >
    <template v-if="quarantineEnabledInput">
      <label for="q-threshold">{{ t("components.guard_editor_quarantine.threshold_label") }}</label>
      <input id="q-threshold" v-model="quarantineThresholdInput" type="text" inputmode="numeric" />
      <p v-if="quarantineThresholdError" class="field-error">{{ quarantineThresholdError }}</p>

      <label for="q-action">{{ t("components.guard_editor_quarantine.action_label") }}</label>
      <SelectMenu id="q-action" v-model="quarantineActionInput" :options="ACTION_OPTIONS" />

      <label for="q-recovery">{{ t("components.guard_editor_quarantine.recovery_label") }}</label>
      <SelectMenu id="q-recovery" v-model="quarantineRecoveryInput" :options="RECOVERY_OPTIONS" />

      <template v-if="quarantineRecoveryInput === 'auto'">
        <label for="q-cooldown">{{ t("components.guard_editor_quarantine.cooldown_label") }}</label>
        <input
          id="q-cooldown"
          v-model="quarantineCooldownInput"
          type="text"
          inputmode="decimal"
          :placeholder="t('components.guard_editor_quarantine.cooldown_placeholder')"
        />
        <p v-if="quarantineCooldownError" class="field-error">{{ quarantineCooldownError }}</p>
      </template>
    </template>
    <SaveRow
      :label="t('components.guard_editor_quarantine.save')"
      :saving="saving"
      :saved="saved"
      @save="saveQuarantineFn"
    />
    <span v-if="clearedSaved" class="save-ok">{{ t("components.guard_editor_quarantine.cleared") }}</span>
    <p v-if="error" class="field-error">{{ error }}</p>
  </div>
</template>
