<script setup lang="ts">
import { ref, computed, watch } from "vue";
import { usePatchTool } from "@/composables/usePatchTool";
import { useFlash } from "@/composables/useFlash";
import { numberRangeValidator } from "@/utils/fieldParsing";
import type { ContextBudgetConfig, ContextBudgetLlmProvider } from "@/types/api";

const props = defineProps<{
  contextBudget?: ContextBudgetConfig;
  clientName?: string;
  toolName?: string;
}>();
const emit = defineEmits<{ saved: [] }>();

const contextBudgetEnabledInput = ref(Boolean(props.contextBudget));
const contextBudgetModeInput = ref<"truncate" | "llm_summarize">(props.contextBudget?.mode ?? "truncate");
const contextBudgetMaxBytesInput = ref((props.contextBudget?.maxResponseBytes ?? 8_000).toString());
const contextBudgetLlmProviderInput = ref<ContextBudgetLlmProvider>(props.contextBudget?.llm?.provider ?? "openai");
const contextBudgetLlmBaseUrlInput = ref(props.contextBudget?.llm?.baseUrl ?? "");
const contextBudgetLlmModelInput = ref(props.contextBudget?.llm?.model ?? "");
// Write-only, like OAuth's client secret field — never populated from a previous save.
const contextBudgetLlmApiKeyInput = ref("");
const saved = ref(false);

watch(
  () => props.contextBudget,
  (cb) => {
    contextBudgetEnabledInput.value = Boolean(cb);
    contextBudgetModeInput.value = cb?.mode ?? "truncate";
    contextBudgetMaxBytesInput.value = (cb?.maxResponseBytes ?? 8_000).toString();
    contextBudgetLlmProviderInput.value = cb?.llm?.provider ?? "openai";
    contextBudgetLlmBaseUrlInput.value = cb?.llm?.baseUrl ?? "";
    contextBudgetLlmModelInput.value = cb?.llm?.model ?? "";
    contextBudgetLlmApiKeyInput.value = ""; // never repopulated from a previous save
  },
);

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
      <select id="cb-mode" v-model="contextBudgetModeInput">
        <option value="truncate">Truncate — cut it off and note how much was omitted</option>
        <option value="llm_summarize">Compress with an LLM — summarize instead of cutting off</option>
      </select>

      <template v-if="contextBudgetModeInput === 'llm_summarize'">
        <p class="hint">
          One extra call per oversized response, made only after this tool's own redaction and guardrail scan have
          already run — the LLM never sees pre-redaction data. Any failure (network, non-2xx, timeout) silently falls
          back to truncation; the tool call itself never fails because of this.
        </p>
        <label for="cb-provider">Provider</label>
        <select id="cb-provider" v-model="contextBudgetLlmProviderInput">
          <option value="openai">OpenAI-compatible (POST {base}/chat/completions)</option>
          <option value="anthropic">Anthropic-compatible (POST {base}/v1/messages)</option>
        </select>

        <label for="cb-base-url">Base URL</label>
        <input
          id="cb-base-url"
          v-model="contextBudgetLlmBaseUrlInput"
          type="text"
          placeholder="https://api.openai.com/v1"
          autocomplete="off"
        />

        <label for="cb-model">Model</label>
        <input id="cb-model" v-model="contextBudgetLlmModelInput" type="text" placeholder="gpt-4o-mini" autocomplete="off" />

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
    <button
      type="button"
      class="btn-secondary desc-save"
      :disabled="saving || Boolean(contextBudgetBytesError || contextBudgetLlmError)"
      @click="saveContextBudgetFn"
    >
      {{ saving ? "Saving…" : "Save context budget" }}
    </button>
    <span v-if="saved" class="save-ok">Saved</span>
    <p v-if="error" class="field-error">{{ error }}</p>
  </div>
</template>
