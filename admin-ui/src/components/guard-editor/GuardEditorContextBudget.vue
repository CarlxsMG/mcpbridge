<script setup lang="ts">
import { ref, computed, watch } from "vue";
import { useI18n } from "vue-i18n";
import { usePatchTool } from "@/composables/usePatchTool";
import { useFlash } from "@/composables/useFlash";
import { usePropDraft } from "@/composables/useFieldDraft";
import SaveRow from "@/components/ui/SaveRow.vue";
import SelectMenu from "@/components/ui/SelectMenu.vue";
import { numberRangeValidator } from "@/utils/fieldParsing";
import { tk } from "@/i18n";
import type { ContextBudgetConfig, ContextBudgetLlmProvider, ContextBudgetMode } from "@/types/api";

const { t } = useI18n({ useScope: "global" });

const MODE_OPTIONS: { value: ContextBudgetMode; label: string }[] = [
  { value: "truncate", label: t("components.guard_editor_context_budget.mode.truncate") },
  { value: "llm_summarize", label: t("components.guard_editor_context_budget.mode.llm") },
];
const LLM_PROVIDER_OPTIONS: { value: ContextBudgetLlmProvider; label: string }[] = [
  { value: "openai", label: t("components.guard_editor_context_budget.provider.openai") },
  { value: "anthropic", label: t("components.guard_editor_context_budget.provider.anthropic") },
];

const props = defineProps<{
  contextBudget?: ContextBudgetConfig;
  clientName?: string;
  toolName?: string;
}>();
const emit = defineEmits<{ saved: [] }>();

const contextBudgetEnabledInput = usePropDraft(() => Boolean(props.contextBudget));
const contextBudgetModeInput = usePropDraft(() => props.contextBudget?.mode ?? "truncate");
const contextBudgetMaxBytesInput = usePropDraft(() => (props.contextBudget?.maxResponseBytes ?? 8_000).toString());
const contextBudgetLlmProviderInput = usePropDraft<ContextBudgetLlmProvider>(
  () => props.contextBudget?.llm?.provider ?? "openai",
);
const contextBudgetLlmBaseUrlInput = usePropDraft(() => props.contextBudget?.llm?.baseUrl ?? "");
const contextBudgetLlmModelInput = usePropDraft(() => props.contextBudget?.llm?.model ?? "");
// Write-only, like OAuth's client secret field — never populated from a previous save.
const contextBudgetLlmApiKeyInput = ref("");
watch(
  () => props.contextBudget,
  () => {
    contextBudgetLlmApiKeyInput.value = "";
  },
);
const saved = ref(false);

const contextBudgetBytesError = computed(() => {
  if (!contextBudgetEnabledInput.value) return null;
  return numberRangeValidator({ integer: true, min: 256, message: t("components.guard_editor_context_budget.bytes_error") })(
    contextBudgetMaxBytesInput.value,
  );
});

const contextBudgetLlmError = computed(() => {
  if (!contextBudgetEnabledInput.value || contextBudgetModeInput.value !== "llm_summarize") return null;
  if (!contextBudgetLlmBaseUrlInput.value.trim()) return t("components.guard_editor_context_budget.base_url_required");
  if (!contextBudgetLlmModelInput.value.trim()) return t("components.guard_editor_context_budget.model_required");
  if (!contextBudgetLlmApiKeyInput.value.trim()) return t("components.guard_editor_context_budget.api_key_required");
  return null;
});

const { saving, error, patchField } = usePatchTool(
  () => props.clientName ?? "",
  () => props.toolName,
);
const { flash } = useFlash();

async function saveContextBudgetFn() {
  if (!contextBudgetEnabledInput.value) {
    const ok = await patchField("contextBudget", null, tk("components.guard_editor_context_budget.errors.save_failed"));
    if (ok) {
      flash(saved);
      emit("saved");
    }
    return;
  }
  if (contextBudgetBytesError.value || contextBudgetLlmError.value) return;
  const ok = await patchField(
    "contextBudget",
    {
      mode: contextBudgetModeInput.value,
      maxResponseBytes: Number(contextBudgetMaxBytesInput.value),
      llm:
        contextBudgetModeInput.value === "llm_summarize"
          ? {
              provider: contextBudgetLlmProviderInput.value,
              baseUrl: contextBudgetLlmBaseUrlInput.value.trim(),
              model: contextBudgetLlmModelInput.value.trim(),
              apiKey: contextBudgetLlmApiKeyInput.value,
            }
          : undefined,
    },
    tk("components.guard_editor_context_budget.errors.save_failed"),
  );
  if (ok) {
    flash(saved);
    emit("saved");
  }
}
</script>

<template>
  <h3>{{ t('components.guard_editor_context_budget.title') }}</h3>
  <div class="field">
    <label class="checkline"
      ><input v-model="contextBudgetEnabledInput" type="checkbox" /> {{ t('components.guard_editor_context_budget.enable_label') }}</label
    >
    <p class="hint">
      {{ t('components.guard_editor_context_budget.hint') }}
    </p>
    <template v-if="contextBudgetEnabledInput">
      <label for="cb-max-bytes">{{ t('components.guard_editor_context_budget.bytes_label') }}</label>
      <input id="cb-max-bytes" v-model="contextBudgetMaxBytesInput" type="text" inputmode="numeric" />
      <p v-if="contextBudgetBytesError" class="field-error">{{ contextBudgetBytesError }}</p>

      <label for="cb-mode">{{ t('components.guard_editor_context_budget.mode_label') }}</label>
      <SelectMenu id="cb-mode" v-model="contextBudgetModeInput" :options="MODE_OPTIONS" />

      <template v-if="contextBudgetModeInput === 'llm_summarize'">
        <p class="hint">
          {{ t('components.guard_editor_context_budget.llm_hint') }}
        </p>
        <label for="cb-provider">{{ t('components.guard_editor_context_budget.provider_label') }}</label>
        <SelectMenu id="cb-provider" v-model="contextBudgetLlmProviderInput" :options="LLM_PROVIDER_OPTIONS" />

        <label for="cb-base-url">{{ t('components.guard_editor_context_budget.base_url_label') }}</label>
        <input
          id="cb-base-url"
          v-model="contextBudgetLlmBaseUrlInput"
          type="text"
          placeholder="https://api.openai.com/v1"
          autocomplete="off"
        />

        <label for="cb-model">{{ t('components.guard_editor_context_budget.model_label') }}</label>
        <input
          id="cb-model"
          v-model="contextBudgetLlmModelInput"
          type="text"
          placeholder="gpt-4o-mini"
          autocomplete="off"
        />

        <label for="cb-api-key">{{ t('components.guard_editor_context_budget.api_key_label') }}</label>
        <p class="hint">
          {{
            contextBudget?.llm
              ? t('components.guard_editor_context_budget.api_key_hint_configured')
              : t('components.guard_editor_context_budget.api_key_hint_new')
          }}
        </p>
        <input
          id="cb-api-key"
          v-model="contextBudgetLlmApiKeyInput"
          class="api-key-input"
          type="password"
          :placeholder="t('components.guard_editor_context_budget.api_key_placeholder')"
          autocomplete="off"
        />
        <p v-if="contextBudgetLlmError" class="field-error">{{ contextBudgetLlmError }}</p>
      </template>
    </template>
    <SaveRow :label="t('components.guard_editor_context_budget.save')" :saving="saving" :saved="saved" :error="error" @save="saveContextBudgetFn" />
  </div>
</template>