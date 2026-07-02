<script setup lang="ts">
import { ref, computed, watch } from "vue";
import type { ToolGuardConfig } from "../types/api";
import ConfirmDialog from "./ConfirmDialog.vue";
import { KeyRound, ShieldCheck } from "lucide-vue-next";

const props = defineProps<{
  guards?: ToolGuardConfig;
  override?: { description?: string; params?: Record<string, { description?: string }>; displayName?: string };
  guardrails?: { denyPatterns: string[]; blockSecrets: boolean; scanResponses: boolean };
  clientName?: string;
  toolName?: string;
  tags?: string[];
  redactPaths?: string[];
  saving?: boolean;
}>();

const emit = defineEmits<{
  save: [payload: { rateLimitPerMin?: number; timeoutMs?: number; allowedApiKeys?: string[] } | null];
  saveOverride: [payload: { description?: string; params?: Record<string, { description?: string }>; displayName?: string } | null];
  saveTags: [tags: string[]];
  saveRedaction: [paths: string[]];
  saveGuardrails: [payload: { denyPatterns: string[]; blockSecrets: boolean; scanResponses: boolean } | null];
}>();

const descriptionInput = ref(props.override?.description ?? "");
const displayNameInput = ref(props.override?.displayName ?? "");
const denyPatternsInput = ref((props.guardrails?.denyPatterns ?? []).join("\n"));
const blockSecretsInput = ref(props.guardrails?.blockSecrets ?? false);
const scanResponsesInput = ref(props.guardrails?.scanResponses ?? false);
const tagsInput = ref((props.tags ?? []).join(", "));
const redactInput = ref((props.redactPaths ?? []).join("\n"));

const rateLimitInput = ref(props.guards?.rateLimitPerMin?.toString() ?? "");
const timeoutInput = ref(props.guards?.timeoutMs?.toString() ?? "");
const rateLimitTouched = ref(false);
const timeoutTouched = ref(false);
const displayNameTouched = ref(false);
const newApiKey = ref("");
const showApiKey = ref(false);
const hasAllowedKeysGuard = ref(Boolean(props.guards?.allowedKeyHashes?.length));
const existingKeyCount = ref(props.guards?.allowedKeyHashes?.length ?? 0);
const replacementKeys = ref<string[]>([]);
const pendingClear = ref(false);

const savingMain = ref(false);
const savedMain = ref(false);
const clearingGuards = ref(false);
const savedClear = ref(false);
const savingPresentation = ref(false);
const savedPresentation = ref(false);
const savingTags = ref(false);
const savedTags = ref(false);
const savingRedaction = ref(false);
const savedRedaction = ref(false);
const savingGuardrails = ref(false);
const savedGuardrails = ref(false);

function flashSaved(flag: { value: boolean }) {
  flag.value = true;
  setTimeout(() => {
    flag.value = false;
  }, 2000);
}

// The parent's `saving` flag is shared across every guard/override/tag/
// redaction/guardrail save, so it flipping back to false is the only signal
// available when an action fails (the per-field prop watches below only fire
// on success, once the parent reloads the client). Use it as a catch-all
// reset so a failed save doesn't leave a button stuck on "Saving…".
watch(
  () => props.saving,
  (s) => {
    if (s) return;
    savingMain.value = false;
    clearingGuards.value = false;
    savingPresentation.value = false;
    savingTags.value = false;
    savingRedaction.value = false;
    savingGuardrails.value = false;
  }
);

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
    if (savingMain.value) {
      savingMain.value = false;
      flashSaved(savedMain);
    }
    if (clearingGuards.value) {
      clearingGuards.value = false;
      flashSaved(savedClear);
    }
  }
);

watch(
  () => props.override,
  (o) => {
    descriptionInput.value = o?.description ?? "";
    displayNameInput.value = o?.displayName ?? "";
    displayNameTouched.value = false;
    if (savingPresentation.value) {
      savingPresentation.value = false;
      flashSaved(savedPresentation);
    }
  }
);

const displayNameError = computed(() => {
  const v = displayNameInput.value.trim();
  if (!v) return null;
  return /^[a-z0-9][a-z0-9_-]{0,62}$/.test(v) ? null : "Lowercase letters, digits, - and _; 1-63 chars";
});

const advertisedName = computed(() => {
  const seg = displayNameInput.value.trim() || props.toolName || "tool";
  return `${props.clientName ?? "client"}__${seg}`;
});

watch(
  () => props.tags,
  (t) => {
    tagsInput.value = (t ?? []).join(", ");
    if (savingTags.value) {
      savingTags.value = false;
      flashSaved(savedTags);
    }
  }
);

watch(
  () => props.redactPaths,
  (p) => {
    redactInput.value = (p ?? []).join("\n");
    if (savingRedaction.value) {
      savingRedaction.value = false;
      flashSaved(savedRedaction);
    }
  }
);

watch(
  () => props.guardrails,
  (g) => {
    denyPatternsInput.value = (g?.denyPatterns ?? []).join("\n");
    blockSecretsInput.value = g?.blockSecrets ?? false;
    scanResponsesInput.value = g?.scanResponses ?? false;
    if (savingGuardrails.value) {
      savingGuardrails.value = false;
      flashSaved(savedGuardrails);
    }
  }
);

function saveGuardrailsFn() {
  const denyPatterns = denyPatternsInput.value.split("\n").map((p) => p.trim()).filter(Boolean);
  savingGuardrails.value = true;
  if (denyPatterns.length === 0 && !blockSecretsInput.value && !scanResponsesInput.value) {
    emit("saveGuardrails", null);
    return;
  }
  emit("saveGuardrails", { denyPatterns, blockSecrets: blockSecretsInput.value, scanResponses: scanResponsesInput.value });
}

const rateLimitError = computed(() => {
  if (!rateLimitInput.value) return null;
  const n = Number(rateLimitInput.value);
  return Number.isFinite(n) && n > 0 ? null : "Must be a positive number";
});

const timeoutError = computed(() => {
  if (!timeoutInput.value) return null;
  const n = Number(timeoutInput.value);
  return Number.isFinite(n) && n > 0 ? null : "Must be a positive number";
});

const isValid = computed(() => !rateLimitError.value && !timeoutError.value);

const hasAnyGuard = computed(() => existingKeyCount.value > 0 || Boolean(props.guards?.rateLimitPerMin) || Boolean(props.guards?.timeoutMs));

const previewJson = computed(() => {
  const preview: Record<string, unknown> = {};
  if (rateLimitInput.value && !rateLimitError.value) preview.rateLimitPerMin = Number(rateLimitInput.value);
  if (timeoutInput.value && !timeoutError.value) preview.timeoutMs = Number(timeoutInput.value);
  if (hasAllowedKeysGuard.value) {
    preview.allowedApiKeys = replacementKeys.value.length > 0 ? `${replacementKeys.value.length} new key(s)` : `${existingKeyCount.value} key(s) unchanged`;
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

function submit() {
  if (!isValid.value) return;
  const payload: { rateLimitPerMin?: number; timeoutMs?: number; allowedApiKeys?: string[] } = {};
  if (rateLimitInput.value) payload.rateLimitPerMin = Number(rateLimitInput.value);
  if (timeoutInput.value) payload.timeoutMs = Number(timeoutInput.value);
  // Only send allowedApiKeys when the operator actually typed replacement
  // keys — otherwise leave the existing (hashed, unrecoverable) set alone.
  if (replacementKeys.value.length > 0) payload.allowedApiKeys = replacementKeys.value;
  savingMain.value = true;
  emit("save", payload);
}

function requestClear() {
  if (!hasAnyGuard.value) {
    clearingGuards.value = true;
    emit("save", null);
    return;
  }
  pendingClear.value = true;
}

function confirmClear() {
  pendingClear.value = false;
  clearingGuards.value = true;
  emit("save", null);
}

function saveOverrideFn() {
  if (displayNameError.value) return;
  const desc = descriptionInput.value.trim();
  const displayName = displayNameInput.value.trim();
  const params = props.override?.params;
  savingPresentation.value = true;
  if (!desc && !displayName && (!params || Object.keys(params).length === 0)) {
    emit("saveOverride", null);
    return;
  }
  // Preserve any param-level overrides set via the API; the UI edits the
  // description and the display-name alias.
  emit("saveOverride", { description: desc || undefined, displayName: displayName || undefined, params });
}

function saveTagsFn() {
  const tags = tagsInput.value.split(",").map((t) => t.trim()).filter(Boolean);
  savingTags.value = true;
  emit("saveTags", tags);
}

function saveRedactionFn() {
  const paths = redactInput.value.split(/[\n,]/).map((p) => p.trim()).filter(Boolean);
  savingRedaction.value = true;
  emit("saveRedaction", paths);
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
        {{ existingKeyCount > 0 ? `${existingKeyCount} key(s) currently allowed.` : "No restriction — any valid MCP key may call this tool." }}
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

    <h3>Presentation</h3>
    <div class="field">
      <label for="tool-display-name">Display name (alias)</label>
      <p class="hint">
        Renames the tool for MCP clients. The <code>{{ clientName ?? "client" }}__</code> prefix is always kept.
        Leave blank to use the registered name. Advertised as: <code>{{ advertisedName }}</code>
      </p>
      <input
        id="tool-display-name"
        v-model="displayNameInput"
        type="text"
        placeholder="e.g. issues"
        @keydown.enter.prevent
        @blur="displayNameTouched = true"
      />
      <p v-if="displayNameTouched && displayNameError" class="field-error">{{ displayNameError }}</p>
    </div>

    <div class="field">
      <label for="tool-desc">Advertised description override</label>
      <p class="hint">Replaces what MCP clients see for this tool in tools/list. Leave blank to use the registered description.</p>
      <textarea id="tool-desc" v-model="descriptionInput" rows="3" placeholder="Registered description is used when blank"></textarea>
      <button type="button" class="btn-secondary desc-save" :disabled="saving || Boolean(displayNameError)" @click="saveOverrideFn">
        {{ savingPresentation ? "Saving…" : "Save presentation" }}
      </button>
      <span v-if="savedPresentation" class="save-ok">Saved</span>
    </div>

    <h3>Tags</h3>
    <div class="field">
      <label for="tool-tags">Tags</label>
      <p class="hint">Comma-separated (lowercase letters, digits, - and _). Used to organize and filter tools.</p>
      <input id="tool-tags" v-model="tagsInput" type="text" placeholder="billing, read-only" @keydown.enter.prevent />
      <button type="button" class="btn-secondary desc-save" :disabled="saving" @click="saveTagsFn">
        {{ savingTags ? "Saving…" : "Save tags" }}
      </button>
      <span v-if="savedTags" class="save-ok">Saved</span>
    </div>

    <h3>Redaction</h3>
    <div class="field">
      <label for="tool-redact">Response redaction paths</label>
      <p class="hint">One dot-path per line (e.g. user.ssn, items.*.secret). Matching JSON values are replaced with [REDACTED] before returning to the caller.</p>
      <textarea id="tool-redact" v-model="redactInput" rows="3" placeholder="user.password&#10;items.*.token"></textarea>
      <button type="button" class="btn-secondary desc-save" :disabled="saving" @click="saveRedactionFn">
        {{ savingRedaction ? "Saving…" : "Save redaction" }}
      </button>
      <span v-if="savedRedaction" class="save-ok">Saved</span>
    </div>

    <h3><ShieldCheck :size="15" stroke-width="2" aria-hidden="true" /> Guardrails</h3>
    <div class="field">
      <label for="tool-deny">Content guardrails</label>
      <p class="hint">Input deny patterns (one regex per line). A call whose arguments match any pattern is rejected before dispatch.</p>
      <textarea id="tool-deny" v-model="denyPatternsInput" rows="2" placeholder="\bDROP\s+TABLE\b&#10;rm\s+-rf"></textarea>
      <label class="checkline"><input type="checkbox" v-model="blockSecretsInput" /> Block arguments that look like secrets (AWS keys, private keys, tokens…)</label>
      <label class="checkline"><input type="checkbox" v-model="scanResponsesInput" /> Scan responses for prompt-injection and wrap flagged output</label>
      <button type="button" class="btn-secondary desc-save" :disabled="saving" @click="saveGuardrailsFn">
        {{ savingGuardrails ? "Saving…" : "Save guardrails" }}
      </button>
      <span v-if="savedGuardrails" class="save-ok">Saved</span>
    </div>

    <details class="preview">
      <summary>Preview</summary>
      <pre>{{ previewJson }}</pre>
    </details>

    <div class="actions">
      <span class="action-group">
        <button type="button" class="btn-secondary" @click="requestClear" :disabled="saving">
          {{ clearingGuards ? "Clearing…" : "Clear guards" }}
        </button>
        <span v-if="savedClear" class="save-ok">Cleared</span>
      </span>
      <span class="action-group">
        <button type="submit" class="btn-primary" :disabled="!isValid || saving">
          {{ savingMain ? "Saving…" : "Save guards" }}
        </button>
        <span v-if="savedMain" class="save-ok">Saved</span>
      </span>
    </div>
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

<style scoped>
.guard-editor {
  display: flex;
  flex-direction: column;
  gap: 1.1rem;
  max-width: 420px;
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
.field label {
  display: block;
  font-weight: 600;
  margin-bottom: 0.3rem;
  font-size: 0.9rem;
}
.field input[type="text"],
.field input.api-key-input,
.field textarea {
  width: 100%;
  padding: 0.45rem 0.6rem;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  font-size: 0.9rem;
  font-family: var(--font-body);
  box-sizing: border-box;
}
.field textarea {
  resize: vertical;
}
.desc-save {
  margin-top: 0.5rem;
}
.checkline {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  font-weight: 400;
  font-size: 0.85rem;
  margin-top: 0.5rem;
}
.checkline input {
  width: auto;
}
.field-error {
  color: var(--breach);
  font-size: 0.8rem;
  margin: 0.25rem 0 0;
}
.hint {
  font-size: 0.8rem;
  color: var(--text-secondary);
  margin: 0 0 0.5rem;
}
.hint.warn {
  color: var(--canary);
}
.key-input {
  display: flex;
  gap: 0.4rem;
}
.key-list {
  list-style: none;
  padding: 0;
  margin: 0.5rem 0 0;
  font-size: 0.85rem;
}
.link-btn {
  background: none;
  border: none;
  cursor: pointer;
  font-size: 0.8rem;
  padding: 0 0 0 0.5rem;
}
.preview {
  font-size: 0.8rem;
}
.preview pre {
  background: var(--surface-sunken);
  padding: 0.6rem;
  border-radius: var(--radius-sm);
  overflow-x: auto;
}
.actions {
  display: flex;
  justify-content: space-between;
  gap: 0.6rem;
}
.action-group {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
}
.save-ok {
  color: var(--ok);
  font-size: 0.8rem;
  font-weight: 600;
}
</style>
