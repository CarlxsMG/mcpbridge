<script setup lang="ts">
import { ref, computed, watch } from "vue";
import { usePatchTool } from "@/composables/usePatchTool";
import { useFlash } from "@/composables/useFlash";
import { usePropDraft } from "@/composables/useFieldDraft";
import SaveRow from "@/components/ui/SaveRow.vue";
import SelectMenu from "@/components/ui/SelectMenu.vue";
import { numberRangeValidator } from "@/utils/fieldParsing";
import type { ContextBudgetConfig, ContextBudgetLlmProvider, ContextBudgetMode } from "@/types/api";

const MODE_OPTIONS: { value: ContextBudgetMode; label: string }[] = [
  { value: "truncate", label: "Truncate — cut it off and note how much was omitted" },
  { value: "llm_summarize", label: "Compress with an LLM — summarize instead of cutting off" },
];
const LLM_PROVIDER_OPTIONS: { value: ContextBudgetLlmProvider; label: string }[] = [
  { value: "openai", label: "OpenAI-compatible (POST {base}/chat/completions)" },
  { value: "anthropic", label: "Anthropic-compatible (POST {base}/v1/messages)" },
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
// Write-only, like OAuth's client secret field — never populated from a previous save. Doesn't
// mirror a prop value (always blank), so it keeps its own ref + watch instead of usePropDraft.
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
  return numberRangeValidator({ integer: true, min: 256, message: "Must be a whole number of at least 256 bytes" })(
    contextBudgetMaxBytesInput.value,
  );
});

const contextBudgetLlmError = computed(() => {
  if (!contextBudgetEnabledInput.value || contextBudgetModeInput.value !== "llm_summarize") return null;
  if (!contextBudgetLlmBaseUrlInput.value.trim()) return "Base URL is required";
  if (!contextBudgetLlmModelInput.value.trim()) return "Model is required";
  if (!contextBudgetLlmApiKeyInput.value.trim()) return "API key is required";
  return null;
});

const { saving, error, patchField } = usePatchTool(
  () => props.clientName ?? "",
  () => props.toolName,
);
const { flash } = useFlash();

async function saveContextBudgetFn() {
  if (!contextBudgetEnabledInput.value) {
    const ok = await patchField("contextBudget", null, "Failed to save context budget.");
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
    "Failed to save context budget.",
  );
  if (ok) {
    flash(saved);
    emit("saved");
  }
}
</script>

<template>
  <h3>Context budget</h3>
  <div class="field">
    <label class="checkline"
      ><input v-model="contextBudgetEnabledInput" type="checkbox" /> Cap this tool's response size so it can't blow an
      agent's context window</label
    >
    <p class="hint">
      No budget configured (the default) means responses are returned unbounded, exactly as today. Once enabled, a
      response over the limit is either cut off with a marker, or — if you configure an LLM below — compressed into a
      faithful summary instead.
    </p>
    <template v-if="contextBudgetEnabledInput">
      <label for="cb-max-bytes">Max response size (bytes)</label>
      <input id="cb-max-bytes" v-model="contextBudgetMaxBytesInput" type="text" inputmode="numeric" />
      <p v-if="contextBudgetBytesError" class="field-error">{{ contextBudgetBytesError }}</p>

      <label for="cb-mode">Mode when a response exceeds the limit</label>
      <SelectMenu id="cb-mode" v-model="contextBudgetModeInput" :options="MODE_OPTIONS" />

      <template v-if="contextBudgetModeInput === 'llm_summarize'">
        <p class="hint">
          One extra call per oversized response, made only after this tool's own redaction and guardrail scan have
          already run — the LLM never sees pre-redaction data. Any failure (network, non-2xx, timeout) silently falls
          back to truncation; the tool call itself never fails because of this.
        </p>
        <label for="cb-provider">Provider</label>
        <SelectMenu id="cb-provider" v-model="contextBudgetLlmProviderInput" :options="LLM_PROVIDER_OPTIONS" />

        <label for="cb-base-url">Base URL</label>
        <input
          id="cb-base-url"
          v-model="contextBudgetLlmBaseUrlInput"
          type="text"
          placeholder="https://api.openai.com/v1"
          autocomplete="off"
        />

        <label for="cb-model">Model</label>
        <input
          id="cb-model"
          v-model="contextBudgetLlmModelInput"
          type="text"
          placeholder="gpt-4o-mini"
          autocomplete="off"
        />

        <label for="cb-api-key">API key</label>
        <p class="hint">
          {{
            contextBudget?.llm
              ? "A key is already configured and is write-only — it cannot be displayed again. Saving here, even just to change another field, replaces it, so re-enter the key."
              : "Bring your own key — stored encrypted, never displayed again once saved."
          }}
        </p>
        <input
          id="cb-api-key"
          v-model="contextBudgetLlmApiKeyInput"
          class="api-key-input"
          type="password"
          placeholder="Paste the raw API key"
          autocomplete="off"
        />
        <p v-if="contextBudgetLlmError" class="field-error">{{ contextBudgetLlmError }}</p>
      </template>
    </template>
    <SaveRow label="Save context budget" :saving="saving" :saved="saved" :error="error" @save="saveContextBudgetFn" />
  </div>
</template>
