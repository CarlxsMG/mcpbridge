<script setup lang="ts">
import { ref, computed, watch } from "vue";
import type { ToolGuardConfig } from "../types/api";

const props = defineProps<{
  guards?: ToolGuardConfig;
  saving?: boolean;
}>();

const emit = defineEmits<{
  save: [payload: { rateLimitPerMin?: number; timeoutMs?: number; allowedApiKeys?: string[] } | null];
}>();

const rateLimitInput = ref(props.guards?.rateLimitPerMin?.toString() ?? "");
const timeoutInput = ref(props.guards?.timeoutMs?.toString() ?? "");
const newApiKey = ref("");
const hasAllowedKeysGuard = ref(Boolean(props.guards?.allowedKeyHashes?.length));
const existingKeyCount = ref(props.guards?.allowedKeyHashes?.length ?? 0);
const replacementKeys = ref<string[]>([]);

watch(
  () => props.guards,
  (g) => {
    rateLimitInput.value = g?.rateLimitPerMin?.toString() ?? "";
    timeoutInput.value = g?.timeoutMs?.toString() ?? "";
    hasAllowedKeysGuard.value = Boolean(g?.allowedKeyHashes?.length);
    existingKeyCount.value = g?.allowedKeyHashes?.length ?? 0;
    replacementKeys.value = [];
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

function clearAll() {
  emit("save", null);
}
</script>

<template>
  <form class="guard-editor" @submit.prevent="submit">
    <div class="field">
      <label for="rate-limit">Rate limit (calls / minute)</label>
      <input id="rate-limit" v-model="rateLimitInput" type="text" inputmode="numeric" placeholder="No limit" />
      <p v-if="rateLimitError" class="field-error">{{ rateLimitError }}</p>
    </div>

    <div class="field">
      <label for="timeout">Timeout override (ms)</label>
      <input id="timeout" v-model="timeoutInput" type="text" inputmode="numeric" placeholder="Use server default" />
      <p v-if="timeoutError" class="field-error">{{ timeoutError }}</p>
    </div>

    <div class="field">
      <label>Allowed API keys</label>
      <p class="hint">
        {{ existingKeyCount > 0 ? `${existingKeyCount} key(s) currently allowed.` : "No restriction — any valid MCP key may call this tool." }}
        Keys are hashed on save; existing keys cannot be displayed again.
      </p>
      <div class="key-input">
        <input v-model="newApiKey" type="text" placeholder="Paste a raw API key to add" @keydown.enter.prevent="addKey" />
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

    <details class="preview">
      <summary>Preview</summary>
      <pre>{{ previewJson }}</pre>
    </details>

    <div class="actions">
      <button type="button" class="btn-secondary" @click="clearAll" :disabled="saving">Clear guards</button>
      <button type="submit" class="btn-primary" :disabled="!isValid || saving">
        {{ saving ? "Saving…" : "Save guards" }}
      </button>
    </div>
  </form>
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
.field input[type="text"] {
  width: 100%;
  padding: 0.45rem 0.6rem;
  border: 1px solid #cfd4da;
  border-radius: 6px;
  font-size: 0.9rem;
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
