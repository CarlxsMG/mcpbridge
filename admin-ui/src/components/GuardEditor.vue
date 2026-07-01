<script setup lang="ts">
import { ref, computed, watch } from "vue";
import type { ToolGuardConfig } from "../types/api";
import ConfirmDialog from "./ConfirmDialog.vue";

const props = defineProps<{
  guards?: ToolGuardConfig;
  override?: { description?: string; params?: Record<string, { description?: string }> };
  tags?: string[];
  saving?: boolean;
}>();

const emit = defineEmits<{
  save: [payload: { rateLimitPerMin?: number; timeoutMs?: number; allowedApiKeys?: string[] } | null];
  saveOverride: [payload: { description?: string; params?: Record<string, { description?: string }> } | null];
  saveTags: [tags: string[]];
}>();

const descriptionInput = ref(props.override?.description ?? "");
const tagsInput = ref((props.tags ?? []).join(", "));

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
  }
);

watch(
  () => props.override,
  (o) => {
    descriptionInput.value = o?.description ?? "";
  }
);

watch(
  () => props.tags,
  (t) => {
    tagsInput.value = (t ?? []).join(", ");
  }
);

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
  emit("save", payload);
}

function requestClear() {
  if (!hasAnyGuard.value) {
    emit("save", null);
    return;
  }
  pendingClear.value = true;
}

function confirmClear() {
  pendingClear.value = false;
  emit("save", null);
}

function saveOverrideFn() {
  const desc = descriptionInput.value.trim();
  const params = props.override?.params;
  if (!desc && (!params || Object.keys(params).length === 0)) {
    emit("saveOverride", null);
    return;
  }
  // Preserve any param-level overrides set via the API; the UI only edits the description.
  emit("saveOverride", { description: desc || undefined, params });
}

function saveTagsFn() {
  const tags = tagsInput.value.split(",").map((t) => t.trim()).filter(Boolean);
  emit("saveTags", tags);
}
</script>

<template>
  <form class="guard-editor" @submit.prevent="submit">
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
          <button type="button" class="link-btn" @click="removeReplacementKey(i)">remove</button>
        </li>
      </ul>
      <p v-if="replacementKeys.length" class="hint warn">
        Saving will REPLACE the entire allow-list with these {{ replacementKeys.length }} key(s).
      </p>
    </div>

    <div class="field">
      <label for="tool-desc">Advertised description override</label>
      <p class="hint">Replaces what MCP clients see for this tool in tools/list. Leave blank to use the registered description.</p>
      <textarea id="tool-desc" v-model="descriptionInput" rows="3" placeholder="Registered description is used when blank"></textarea>
      <button type="button" class="btn-secondary desc-save" :disabled="saving" @click="saveOverrideFn">Save description</button>
    </div>

    <div class="field">
      <label for="tool-tags">Tags</label>
      <p class="hint">Comma-separated (lowercase letters, digits, - and _). Used to organize and filter tools.</p>
      <input id="tool-tags" v-model="tagsInput" type="text" placeholder="billing, read-only" />
      <button type="button" class="btn-secondary desc-save" :disabled="saving" @click="saveTagsFn">Save tags</button>
    </div>

    <details class="preview">
      <summary>Preview</summary>
      <pre>{{ previewJson }}</pre>
    </details>

    <div class="actions">
      <button type="button" class="btn-secondary" @click="requestClear" :disabled="saving">Clear guards</button>
      <button type="submit" class="btn-primary" :disabled="!isValid || saving">
        {{ saving ? "Saving…" : "Save guards" }}
      </button>
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
  border: 1px solid #cfd4da;
  border-radius: 6px;
  font-size: 0.9rem;
  box-sizing: border-box;
}
.field textarea {
  font-family: inherit;
  resize: vertical;
}
.desc-save {
  margin-top: 0.5rem;
}
.field-error {
  color: #a11212;
  font-size: 0.8rem;
  margin: 0.25rem 0 0;
}
.hint {
  font-size: 0.8rem;
  color: #63676e;
  margin: 0 0 0.5rem;
}
.hint.warn {
  color: #8a5a00;
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
  color: #a11212;
  cursor: pointer;
  font-size: 0.8rem;
  padding: 0 0 0 0.5rem;
}
.preview {
  font-size: 0.8rem;
}
.preview pre {
  background: #f4f5f7;
  padding: 0.6rem;
  border-radius: 6px;
  overflow-x: auto;
}
.actions {
  display: flex;
  justify-content: space-between;
  gap: 0.6rem;
}
</style>
