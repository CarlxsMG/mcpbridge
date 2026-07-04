<script setup lang="ts">
import { ref, computed, watch } from "vue";
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
import { useFlash } from "@/composables/useFlash";
import { numberRangeValidator } from "@/composables/fieldParsing";
import { KeyRound } from "lucide-vue-next";

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

// Every extracted section (and this file's own "Rate limit & keys" section) patches
// its own field directly via usePatchTool, then emits/relays `toolChanged` so the
// parent (ServerDetailPage) reloads the client and fresh props flow back down.
const emit = defineEmits<{ toolChanged: [] }>();

const rateLimitInput = ref(props.guards?.rateLimitPerMin?.toString() ?? "");
const timeoutInput = ref(props.guards?.timeoutMs?.toString() ?? "");
const rateLimitTouched = ref(false);
const timeoutTouched = ref(false);
const newApiKey = ref("");
const showApiKey = ref(false);
const hasAllowedKeysGuard = ref(Boolean(props.guards?.allowedKeyHashes?.length));
const existingKeyCount = ref(props.guards?.allowedKeyHashes?.length ?? 0);
const replacementKeys = ref<string[]>([]);
const pendingClear = ref(false);
const savedMain = ref(false);
const savedClear = ref(false);
const clearingGuards = ref(false);

// Resets local input state when the drawer switches to a different tool (not on save —
// a successful save resolves via the immediate patchField() return value below, no
// prop round-trip needed).
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

// Number.MIN_VALUE is the smallest representable positive number, so an
// inclusive min of it is equivalent to the original's strict `n > 0` check.
const rateLimitError = computed(() =>
  numberRangeValidator({ min: Number.MIN_VALUE, message: "Must be a positive number" })(rateLimitInput.value),
);

const timeoutError = computed(() =>
  numberRangeValidator({ min: Number.MIN_VALUE, message: "Must be a positive number" })(timeoutInput.value),
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
        ? `${replacementKeys.value.length} new key(s)`
        : `${existingKeyCount.value} key(s) unchanged`;
  }
  return JSON.stringify(preview, null, 2);
});

function addKey() {
  const key = newApiKey.value.trim();
  if (!key) return;
  replacementKeys.value.push(key);
  newApiKey.value = "";
  hasAllowedKeysGuard.value = true;
}

function removeReplacementKey(index: number) {
  replacementKeys.value.splice(index, 1);
}

const { saving, error: mainError, patchField } = usePatchTool(
  () => props.clientName ?? "",
  () => props.toolName,
);
const { flash } = useFlash();

async function submit() {
  if (!isValid.value) return;
  const payload: { rateLimitPerMin?: number; timeoutMs?: number; allowedApiKeys?: string[] } = {};
  if (rateLimitInput.value) payload.rateLimitPerMin = Number(rateLimitInput.value);
  if (timeoutInput.value) payload.timeoutMs = Number(timeoutInput.value);
  // Only send allowedApiKeys when the operator actually typed replacement
  // keys — otherwise leave the existing (hashed, unrecoverable) set alone.
  if (replacementKeys.value.length > 0) payload.allowedApiKeys = replacementKeys.value;
  const ok = await patchField("guards", payload, "Failed to save guards.");
  if (ok) {
    flash(savedMain);
    emit("toolChanged");
  }
}

async function doClear() {
  clearingGuards.value = true;
  const ok = await patchField("guards", null, "Failed to save guards.");
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
  pendingClear.value = true;
}

function confirmClear() {
  pendingClear.value = false;
  doClear();
}
</script>

<template>
  <form class="guard-editor" @submit.prevent="submit">
    <h3><KeyRound :size="15" stroke-width="2" aria-hidden="true" /> Rate limit & keys</h3>
    <div class="field">
      <label for="rate-limit">Rate limit (calls / minute)</label>
      <input
        id="rate-limit"
        v-model="rateLimitInput"
        type="text"
        inputmode="numeric"
        placeholder="No limit"
        @blur="rateLimitTouched = true"
      />
      <p v-if="rateLimitTouched && rateLimitError" class="field-error">{{ rateLimitError }}</p>
    </div>

    <div class="field">
      <label for="timeout">Timeout override (ms)</label>
      <input
        id="timeout"
        v-model="timeoutInput"
        type="text"
        inputmode="numeric"
        placeholder="Use server default"
        @blur="timeoutTouched = true"
      />
      <p v-if="timeoutTouched && timeoutError" class="field-error">{{ timeoutError }}</p>
    </div>

    <div class="field">
      <label>Allowed API keys</label>
      <p class="hint">
        {{
          existingKeyCount > 0
            ? `${existingKeyCount} key(s) currently allowed.`
            : "No restriction — any valid MCP key may call this tool."
        }}
        Keys are hashed on save; existing keys cannot be displayed again.
      </p>
      <div class="key-input">
        <input
          v-model="newApiKey"
          class="api-key-input"
          :type="showApiKey ? 'text' : 'password'"
          placeholder="Paste a raw API key to add"
          autocomplete="off"
          @keydown.enter.prevent="addKey"
        />
        <button type="button" class="btn-secondary" :aria-pressed="showApiKey" @click="showApiKey = !showApiKey">
          {{ showApiKey ? "Hide" : "Show" }}
        </button>
        <button type="button" class="btn-secondary" @click="addKey">Add</button>
      </div>
      <ul v-if="replacementKeys.length" class="key-list">
        <li v-for="(_, i) in replacementKeys" :key="i">
          New key #{{ i + 1 }}
          <button type="button" class="link-btn danger" @click="removeReplacementKey(i)">remove</button>
        </li>
      </ul>
      <p v-if="replacementKeys.length" class="hint warn">
        Saving will REPLACE the entire allow-list with these {{ replacementKeys.length }} key(s).
      </p>
    </div>

    <GuardEditorPresentation :override="override" :client-name="clientName" :tool-name="toolName" @saved="emit('toolChanged')" />
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
    <GuardEditorApproval :approval="approval" :client-name="clientName" :tool-name="toolName" @saved="emit('toolChanged')" />
    <GuardEditorQuarantine
      :quarantine="quarantine"
      :client-name="clientName"
      :tool-name="toolName"
      @saved="emit('toolChanged')"
    />
    <GuardEditorWebSocket :ws="ws" :client-name="clientName" :tool-name="toolName" @saved="emit('toolChanged')" />
    <GuardEditorGraphql :graphql="graphql" :client-name="clientName" :tool-name="toolName" @saved="emit('toolChanged')" />
    <GuardEditorCoalesce :coalesce="coalesce" :client-name="clientName" :tool-name="toolName" @saved="emit('toolChanged')" />
    <GuardEditorCachePurge :client-name="clientName" :tool-name="toolName" />
    <GuardEditorContextBudget
      :context-budget="contextBudget"
      :client-name="clientName"
      :tool-name="toolName"
      @saved="emit('toolChanged')"
    />

    <details class="preview">
      <summary>Preview</summary>
      <pre>{{ previewJson }}</pre>
    </details>

    <div class="actions">
      <span class="action-group">
        <button type="button" class="btn-secondary" :disabled="saving" @click="requestClear">
          {{ clearingGuards ? "Clearing…" : "Clear guards" }}
        </button>
        <span v-if="savedClear" class="save-ok">Cleared</span>
      </span>
      <span class="action-group">
        <button type="submit" class="btn-primary" :disabled="!isValid || saving">
          {{ saving && !clearingGuards ? "Saving…" : "Save guards" }}
        </button>
        <span v-if="savedMain" class="save-ok">Saved</span>
      </span>
    </div>
    <p v-if="mainError" class="field-error">{{ mainError }}</p>
  </form>

  <ConfirmDialog
    :open="pendingClear"
    title="Clear all guards for this tool?"
    message="This removes the rate limit, timeout override, and API key allow-list. Existing keys are hashed and cannot be restored — you'd need the original raw keys to set the same allow-list again."
    confirm-label="Clear guards"
    danger
    @confirm="confirmClear"
    @cancel="pendingClear = false"
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
