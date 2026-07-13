<script setup lang="ts">
import { ref, computed, watch } from "vue";
import { useI18n } from "vue-i18n";
import type { ToolGuardConfig, ContextBudgetConfig } from "@/types/api";
import ConfirmDialog from "@/components/ui/ConfirmDialog.vue";
import GuardEditorPresentation from "./GuardEditorPresentation.vue";
import GuardEditorTags from "./GuardEditorTags.vue";
import GuardEditorRedaction from "./GuardEditorRedaction.vue";
import GuardEditorGuardrails from "./GuardEditorGuardrails.vue";
import GuardEditorApproval from "./GuardEditorApproval.vue";
import GuardEditorQuarantine from "./GuardEditorQuarantine.vue";
import GuardEditorWebSocket from "./GuardEditorWebSocket.vue";
import GuardEditorGraphql from "./GuardEditorGraphql.vue";
import GuardEditorCoalesce from "./GuardEditorCoalesce.vue";
import GuardEditorCachePurge from "./GuardEditorCachePurge.vue";
import GuardEditorContextBudget from "./GuardEditorContextBudget.vue";
import { usePatchTool } from "@/composables/usePatchTool";
import { useConfirmAction } from "@/composables/useConfirmAction";
import { useFlash } from "@/composables/useFlash";
import { numberRangeValidator } from "@/utils/fieldParsing";
import { KeyRound } from "lucide-vue-next";
import { tk } from "@/i18n";

const props = defineProps<{
  guards?: ToolGuardConfig;
  override?: { description?: string; params?: Record<string, { description?: string }>; displayName?: string };
  guardrails?: { denyPatterns: string[]; blockSecrets: boolean; scanResponses: boolean };
  coalesce?: { enabled: boolean };
  approval?: { required: boolean; requiredLevels: number };
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
  ws?: { enabled: boolean; wsUrl: string; persistent: boolean };
  graphql?: { enabled: boolean; query: string };
  contextBudget?: ContextBudgetConfig;
  clientName?: string;
  toolName?: string;
  tags?: string[];
  redactPaths?: string[];
}>();

const emit = defineEmits<{ toolChanged: [] }>();
const { t } = useI18n({ useScope: "global" });

const rateLimitInput = ref(props.guards?.rateLimitPerMin?.toString() ?? "");
const timeoutInput = ref(props.guards?.timeoutMs?.toString() ?? "");
const rateLimitTouched = ref(false);
const timeoutTouched = ref(false);
const newApiKey = ref("");
const showApiKey = ref(false);
const hasAllowedKeysGuard = ref(Boolean(props.guards?.allowedKeyHashes?.length));
const existingKeyCount = ref(props.guards?.allowedKeyHashes?.length ?? 0);
let nextKeyId = 0;
const replacementKeys = ref<{ id: number; value: string }[]>([]);
const savedMain = ref(false);
const savedClear = ref(false);
const clearingGuards = ref(false);

watch(
  () => props.guards,
  (g) => {
    rateLimitInput.value = g?.rateLimitPerMin?.toString() ?? "";
    timeoutInput.value = g?.timeoutMs?.toString() ?? "";
    rateLimitTouched.value = false;
    timeoutTouched.value = false;
    hasAllowedKeysGuard.value = Boolean(g?.allowedKeyHashes?.length);
    existingKeyCount.value = g?.allowedKeyHashes?.length ?? 0;
    replacementKeys.value = [];
  },
);

const rateLimitError = computed(() =>
  numberRangeValidator({ min: Number.MIN_VALUE, message: t("components.guard_editor.positive_number") })(
    rateLimitInput.value,
  ),
);

const timeoutError = computed(() =>
  numberRangeValidator({ min: Number.MIN_VALUE, message: t("components.guard_editor.positive_number") })(
    timeoutInput.value,
  ),
);

const isValid = computed(() => !rateLimitError.value && !timeoutError.value);

const hasAnyGuard = computed(
  () => existingKeyCount.value > 0 || Boolean(props.guards?.rateLimitPerMin) || Boolean(props.guards?.timeoutMs),
);

const previewJson = computed(() => {
  const preview: Record<string, unknown> = {};
  if (rateLimitInput.value && !rateLimitError.value) preview.rateLimitPerMin = Number(rateLimitInput.value);
  if (timeoutInput.value && !timeoutError.value) preview.timeoutMs = Number(timeoutInput.value);
  if (hasAllowedKeysGuard.value) {
    preview.allowedApiKeys =
      replacementKeys.value.length > 0
        ? t("components.guard_editor.preview_new_keys", { count: replacementKeys.value.length })
        : t("components.guard_editor.preview_existing_keys", { count: existingKeyCount.value });
  }
  return JSON.stringify(preview, null, 2);
});

function addKey() {
  const key = newApiKey.value.trim();
  if (!key) return;
  replacementKeys.value.push({ id: nextKeyId++, value: key });
  newApiKey.value = "";
  hasAllowedKeysGuard.value = true;
}

function removeReplacementKey(id: number) {
  const index = replacementKeys.value.findIndex((k) => k.id === id);
  if (index !== -1) replacementKeys.value.splice(index, 1);
}

const {
  saving,
  error: mainError,
  patchField,
} = usePatchTool(
  () => props.clientName ?? "",
  () => props.toolName,
);
const { flash } = useFlash();

const {
  pending: pendingClear,
  request: requestClearConfirm,
  cancel: cancelClear,
  confirm: confirmClearAction,
} = useConfirmAction<true>();

async function submit() {
  if (!isValid.value) return;
  const payload: { rateLimitPerMin?: number; timeoutMs?: number; allowedApiKeys?: string[] } = {};
  if (rateLimitInput.value) payload.rateLimitPerMin = Number(rateLimitInput.value);
  if (timeoutInput.value) payload.timeoutMs = Number(timeoutInput.value);
  if (replacementKeys.value.length > 0) payload.allowedApiKeys = replacementKeys.value.map((k) => k.value);
  const ok = await patchField("guards", payload, tk("components.guard_editor.errors.save_failed"));
  if (ok) {
    flash(savedMain);
    emit("toolChanged");
  }
}

async function doClear() {
  clearingGuards.value = true;
  const ok = await patchField("guards", null, tk("components.guard_editor.errors.save_failed"));
  clearingGuards.value = false;
  if (ok) {
    flash(savedClear);
    emit("toolChanged");
  }
}

function requestClear() {
  if (!hasAnyGuard.value) {
    doClear();
    return;
  }
  requestClearConfirm(true);
}

function confirmClear() {
  return confirmClearAction(doClear);
}
</script>

<template>
  <form class="guard-editor" @submit.prevent="submit">
    <h3>
      <KeyRound :size="15" stroke-width="2" aria-hidden="true" /> {{ t("components.guard_editor.rate_keys_title") }}
    </h3>
    <div class="field">
      <label for="rate-limit">{{ t("components.guard_editor.rate_label") }}</label>
      <input
        id="rate-limit"
        v-model="rateLimitInput"
        type="text"
        inputmode="numeric"
        :placeholder="t('components.guard_editor.no_limit')"
        @blur="rateLimitTouched = true"
      />
      <p v-if="rateLimitTouched && rateLimitError" class="field-error">{{ rateLimitError }}</p>
    </div>

    <div class="field">
      <label for="timeout">{{ t("components.guard_editor.timeout_label") }}</label>
      <input
        id="timeout"
        v-model="timeoutInput"
        type="text"
        inputmode="numeric"
        :placeholder="t('components.guard_editor.use_default')"
        @blur="timeoutTouched = true"
      />
      <p v-if="timeoutTouched && timeoutError" class="field-error">{{ timeoutError }}</p>
    </div>

    <div class="field">
      <label for="new-api-key">{{ t("components.guard_editor.allowed_keys_label") }}</label>
      <p class="hint">
        {{
          existingKeyCount > 0
            ? t("components.guard_editor.existing_keys_count", { count: existingKeyCount })
            : t("components.guard_editor.no_restriction")
        }}
        {{ t("components.guard_editor.keys_hashed_hint") }}
      </p>
      <div class="key-input">
        <input
          id="new-api-key"
          v-model="newApiKey"
          class="api-key-input"
          :type="showApiKey ? 'text' : 'password'"
          :placeholder="t('components.guard_editor.add_key_placeholder')"
          autocomplete="off"
          @keydown.enter.prevent="addKey"
        />
        <button type="button" class="btn-secondary" :aria-pressed="showApiKey" @click="showApiKey = !showApiKey">
          {{ showApiKey ? t("components.guard_editor.hide") : t("components.guard_editor.show") }}
        </button>
        <button type="button" class="btn-secondary" @click="addKey">{{ t("components.guard_editor.add") }}</button>
      </div>
      <ul v-if="replacementKeys.length" class="key-list">
        <li v-for="(k, i) in replacementKeys" :key="k.id">
          {{ t("components.guard_editor.new_key_n", { n: i + 1 }) }}
          <button type="button" class="link-btn danger" @click="removeReplacementKey(k.id)">
            {{ t("components.guard_editor.remove") }}
          </button>
        </li>
      </ul>
      <p v-if="replacementKeys.length" class="hint warn">
        {{ t("components.guard_editor.replace_warning", { count: replacementKeys.length }) }}
      </p>
    </div>

    <GuardEditorPresentation
      :override="override"
      :client-name="clientName"
      :tool-name="toolName"
      @saved="emit('toolChanged')"
    />
    <GuardEditorTags :tags="tags" :client-name="clientName" :tool-name="toolName" @saved="emit('toolChanged')" />
    <GuardEditorRedaction
      :redact-paths="redactPaths"
      :client-name="clientName"
      :tool-name="toolName"
      @saved="emit('toolChanged')"
    />
    <GuardEditorGuardrails
      :guardrails="guardrails"
      :client-name="clientName"
      :tool-name="toolName"
      @saved="emit('toolChanged')"
    />
    <GuardEditorApproval
      :approval="approval"
      :client-name="clientName"
      :tool-name="toolName"
      @saved="emit('toolChanged')"
    />
    <GuardEditorQuarantine
      :quarantine="quarantine"
      :client-name="clientName"
      :tool-name="toolName"
      @saved="emit('toolChanged')"
    />
    <GuardEditorWebSocket :ws="ws" :client-name="clientName" :tool-name="toolName" @saved="emit('toolChanged')" />
    <GuardEditorGraphql
      :graphql="graphql"
      :client-name="clientName"
      :tool-name="toolName"
      @saved="emit('toolChanged')"
    />
    <GuardEditorCoalesce
      :coalesce="coalesce"
      :client-name="clientName"
      :tool-name="toolName"
      @saved="emit('toolChanged')"
    />
    <GuardEditorCachePurge :client-name="clientName" :tool-name="toolName" />
    <GuardEditorContextBudget
      :context-budget="contextBudget"
      :client-name="clientName"
      :tool-name="toolName"
      @saved="emit('toolChanged')"
    />

    <details class="preview">
      <summary>{{ t("components.guard_editor.preview") }}</summary>
      <pre>{{ previewJson }}</pre>
    </details>

    <div class="actions">
      <span class="action-group">
        <button type="button" class="btn-secondary" :disabled="saving" @click="requestClear">
          {{ clearingGuards ? t("components.guard_editor.clearing") : t("components.guard_editor.clear_guards") }}
        </button>
        <span v-if="savedClear" class="save-ok">{{ t("components.guard_editor.cleared") }}</span>
      </span>
      <span class="action-group">
        <button type="submit" class="btn-primary" :disabled="!isValid || saving">
          {{ saving && !clearingGuards ? t("common.saving") : t("components.guard_editor.save_guards") }}
        </button>
        <span v-if="savedMain" class="save-ok">{{ t("components.guard_editor.saved") }}</span>
      </span>
    </div>
    <p v-if="mainError" class="field-error">{{ mainError }}</p>
  </form>

  <ConfirmDialog
    :open="pendingClear !== null"
    :title="t('components.guard_editor.confirm.clear_title')"
    :message="t('components.guard_editor.confirm.clear_message')"
    :confirm-label="t('components.guard_editor.confirm.clear_cta')"
    danger
    @confirm="confirmClear"
    @cancel="cancelClear"
  />
</template>

<style>
/* Shared field styling for GuardEditor + its 11 extracted GuardEditorXxx.vue section
   components — deliberately unscoped (those children render under their own scope
   hash, not this file's), namespaced under .guard-editor so it doesn't leak into the
   rest of the app's own .field/.hint/.checkline conventions. */
.guard-editor {
  display: flex;
  flex-direction: column;
  gap: 1.1rem;
  max-width: 26.25rem;
}
.guard-editor h3 {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  margin: 0 0 0.2rem;
  font-size: 0.85rem;
  font-family: var(--font-body);
  font-weight: 600;
  color: var(--text-secondary);
}
.guard-editor .field label {
  display: block;
  font-weight: 600;
  margin-bottom: 0.3rem;
  font-size: 0.9rem;
}
.guard-editor .field input[type="text"],
.guard-editor .field input.api-key-input,
.guard-editor .field textarea {
  width: 100%;
  padding: 0.45rem 0.6rem;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  font-size: 0.9rem;
  font-family: var(--font-body);
  box-sizing: border-box;
}
.guard-editor .field textarea {
  resize: vertical;
}
.guard-editor .desc-save {
  margin-top: 0.5rem;
}
.guard-editor .checkline {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  font-weight: 400;
  font-size: 0.85rem;
  margin-top: 0.5rem;
}
.guard-editor .checkline input {
  width: auto;
}
.guard-editor .field-error {
  color: var(--breach);
  font-size: 0.8rem;
  margin: 0.25rem 0 0;
}
.guard-editor .hint {
  font-size: 0.8rem;
  color: var(--text-secondary);
  margin: 0 0 0.5rem;
}
.guard-editor .hint.warn {
  color: var(--canary);
}
.guard-editor .quarantine-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  background: var(--breach-soft);
  color: var(--breach);
  border: 1px solid var(--breach);
  border-radius: var(--radius-sm);
  padding: 0.5rem 0.7rem;
  font-size: 0.85rem;
  font-weight: 600;
  margin-bottom: 0.6rem;
}
.guard-editor .field select {
  width: 100%;
  padding: 0.45rem 0.6rem;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  font-size: 0.9rem;
  font-family: var(--font-body);
  box-sizing: border-box;
  margin-bottom: 0.5rem;
}
.guard-editor .key-input {
  display: flex;
  gap: 0.4rem;
}
.guard-editor .key-list {
  list-style: none;
  padding: 0;
  margin: 0.5rem 0 0;
  font-size: 0.85rem;
}
.guard-editor .link-btn {
  background: none;
  border: none;
  cursor: pointer;
  font-size: 0.8rem;
  padding: 0 0 0 0.5rem;
}
.guard-editor .preview {
  font-size: 0.8rem;
}
.guard-editor .preview pre {
  background: var(--surface-sunken);
  padding: 0.6rem;
  border-radius: var(--radius-sm);
  overflow-x: auto;
}
.guard-editor .actions {
  display: flex;
  justify-content: space-between;
  gap: 0.6rem;
}
.guard-editor .action-group {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
}
.guard-editor .save-ok {
  color: var(--ok);
  font-size: 0.8rem;
  font-weight: 600;
}
</style>
