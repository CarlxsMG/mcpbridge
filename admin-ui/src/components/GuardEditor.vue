<script setup lang="ts">
import { ref, computed, watch } from "vue";
import type { ToolGuardConfig, ContextBudgetConfig, ContextBudgetLlmProvider } from "../types/api";
import ConfirmDialog from "./ConfirmDialog.vue";
import { api, ApiError } from "../composables/useApi";
import { KeyRound, ShieldCheck, Eraser } from "lucide-vue-next";

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
  saving?: boolean;
}>();

const emit = defineEmits<{
  save: [payload: { rateLimitPerMin?: number; timeoutMs?: number; allowedApiKeys?: string[] } | null];
  saveOverride: [
    payload: { description?: string; params?: Record<string, { description?: string }>; displayName?: string } | null,
  ];
  saveTags: [tags: string[]];
  saveRedaction: [paths: string[]];
  saveGuardrails: [payload: { denyPatterns: string[]; blockSecrets: boolean; scanResponses: boolean } | null];
  saveCoalesce: [payload: { enabled: boolean } | null];
  saveApproval: [payload: { required: boolean; requiredLevels: number }];
  saveQuarantinePolicy: [
    payload: {
      consecutiveThreshold: number;
      action: "block" | "force_approval" | "observe";
      recoveryMode: "auto" | "manual";
      cooldownMs: number | null;
    } | null,
  ];
  clearQuarantine: [];
  saveWs: [payload: { enabled: boolean; wsUrl: string; persistent: boolean } | null];
  saveGraphql: [payload: { enabled: boolean; query: string } | null];
  saveContextBudget: [
    payload: {
      mode: "truncate" | "llm_summarize";
      maxResponseBytes: number;
      llm?: { provider: ContextBudgetLlmProvider; baseUrl: string; model: string; apiKey: string };
    } | null,
  ];
}>();

const descriptionInput = ref(props.override?.description ?? "");
const displayNameInput = ref(props.override?.displayName ?? "");
const denyPatternsInput = ref((props.guardrails?.denyPatterns ?? []).join("\n"));
const blockSecretsInput = ref(props.guardrails?.blockSecrets ?? false);
const scanResponsesInput = ref(props.guardrails?.scanResponses ?? false);
const coalesceInput = ref(props.coalesce?.enabled ?? false);
const approvalRequiredInput = ref(props.approval?.required ?? false);
const approvalLevelsInput = ref((props.approval?.requiredLevels ?? 1).toString());

const quarantineEnabledInput = ref(Boolean(props.quarantine));
const quarantineThresholdInput = ref((props.quarantine?.policy.consecutiveThreshold ?? 3).toString());
const quarantineActionInput = ref<"block" | "force_approval" | "observe">(props.quarantine?.policy.action ?? "block");
const quarantineRecoveryInput = ref<"auto" | "manual">(props.quarantine?.policy.recoveryMode ?? "manual");
const quarantineCooldownInput = ref(
  props.quarantine?.policy.cooldownMs ? (props.quarantine.policy.cooldownMs / 60_000).toString() : "",
);

const wsEnabledInput = ref(Boolean(props.ws?.enabled));
const wsUrlInput = ref(props.ws?.wsUrl ?? "");
const wsPersistentInput = ref(props.ws?.persistent ?? false);
const graphqlEnabledInput = ref(Boolean(props.graphql?.enabled));
const graphqlQueryInput = ref(props.graphql?.query ?? "");
const tagsInput = ref((props.tags ?? []).join(", "));
const redactInput = ref((props.redactPaths ?? []).join("\n"));

const contextBudgetEnabledInput = ref(Boolean(props.contextBudget));
const contextBudgetModeInput = ref<"truncate" | "llm_summarize">(props.contextBudget?.mode ?? "truncate");
const contextBudgetMaxBytesInput = ref((props.contextBudget?.maxResponseBytes ?? 8_000).toString());
const contextBudgetLlmProviderInput = ref<ContextBudgetLlmProvider>(props.contextBudget?.llm?.provider ?? "openai");
const contextBudgetLlmBaseUrlInput = ref(props.contextBudget?.llm?.baseUrl ?? "");
const contextBudgetLlmModelInput = ref(props.contextBudget?.llm?.model ?? "");
// Write-only, like OAuth's client secret field — never populated from a previous save.
const contextBudgetLlmApiKeyInput = ref("");

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
const savingCoalesce = ref(false);
const savedCoalesce = ref(false);
const savingApproval = ref(false);
const savedApproval = ref(false);
const savingQuarantine = ref(false);
const savedQuarantine = ref(false);
const clearingQuarantine = ref(false);
const savingWs = ref(false);
const savedWs = ref(false);
const savingGraphql = ref(false);
const savedGraphql = ref(false);
const savingContextBudget = ref(false);
const savedContextBudget = ref(false);
const purgingCache = ref(false);
const purgedCache = ref(false);
const purgeCacheError = ref("");

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
    savingCoalesce.value = false;
    savingApproval.value = false;
    savingQuarantine.value = false;
    clearingQuarantine.value = false;
    savingWs.value = false;
    savingContextBudget.value = false;
  },
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
  },
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
  },
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
  },
);

watch(
  () => props.redactPaths,
  (p) => {
    redactInput.value = (p ?? []).join("\n");
    if (savingRedaction.value) {
      savingRedaction.value = false;
      flashSaved(savedRedaction);
    }
  },
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
  },
);

function saveGuardrailsFn() {
  const denyPatterns = denyPatternsInput.value
    .split("\n")
    .map((p) => p.trim())
    .filter(Boolean);
  savingGuardrails.value = true;
  if (denyPatterns.length === 0 && !blockSecretsInput.value && !scanResponsesInput.value) {
    emit("saveGuardrails", null);
    return;
  }
  emit("saveGuardrails", {
    denyPatterns,
    blockSecrets: blockSecretsInput.value,
    scanResponses: scanResponsesInput.value,
  });
}

watch(
  () => props.coalesce,
  (c) => {
    coalesceInput.value = c?.enabled ?? false;
    if (savingCoalesce.value) {
      savingCoalesce.value = false;
      flashSaved(savedCoalesce);
    }
  },
);

function saveCoalesceFn() {
  savingCoalesce.value = true;
  emit("saveCoalesce", coalesceInput.value ? { enabled: true } : null);
}

// Response cache purge (POST /admin-api/clients/:name/tools/:tool/cache/purge). Non-destructive
// to config — only clears already-cached entries — so this skips the ConfirmDialog used for
// actual config-clearing actions elsewhere in this drawer.
async function purgeCacheFn() {
  if (!props.clientName || !props.toolName) return;
  purgeCacheError.value = "";
  purgingCache.value = true;
  try {
    await api.post(
      `/admin-api/clients/${encodeURIComponent(props.clientName)}/tools/${encodeURIComponent(props.toolName)}/cache/purge`,
    );
    purgingCache.value = false;
    flashSaved(purgedCache);
  } catch (err) {
    purgeCacheError.value = err instanceof ApiError ? err.message : "Failed to purge cache.";
    purgingCache.value = false;
  }
}

watch(
  () => props.approval,
  (a) => {
    approvalRequiredInput.value = a?.required ?? false;
    approvalLevelsInput.value = (a?.requiredLevels ?? 1).toString();
    if (savingApproval.value) {
      savingApproval.value = false;
      flashSaved(savedApproval);
    }
  },
);

const approvalLevelsError = computed(() => {
  const n = Number(approvalLevelsInput.value);
  return Number.isInteger(n) && n >= 1 && n <= 10 ? null : "Must be a whole number between 1 and 10";
});

function saveApprovalFn() {
  if (approvalLevelsError.value) return;
  savingApproval.value = true;
  emit("saveApproval", { required: approvalRequiredInput.value, requiredLevels: Number(approvalLevelsInput.value) });
}

watch(
  () => props.quarantine,
  (q) => {
    quarantineEnabledInput.value = Boolean(q);
    quarantineThresholdInput.value = (q?.policy.consecutiveThreshold ?? 3).toString();
    quarantineActionInput.value = q?.policy.action ?? "block";
    quarantineRecoveryInput.value = q?.policy.recoveryMode ?? "manual";
    quarantineCooldownInput.value = q?.policy.cooldownMs ? (q.policy.cooldownMs / 60_000).toString() : "";
    if (savingQuarantine.value) {
      savingQuarantine.value = false;
      flashSaved(savedQuarantine);
    }
    if (clearingQuarantine.value) {
      clearingQuarantine.value = false;
    }
  },
);

const quarantineThresholdError = computed(() => {
  const n = Number(quarantineThresholdInput.value);
  return Number.isInteger(n) && n >= 1 && n <= 100 ? null : "Must be a whole number between 1 and 100";
});

const quarantineCooldownError = computed(() => {
  if (quarantineRecoveryInput.value !== "auto") return null;
  if (!quarantineCooldownInput.value.trim()) return "Required when recovery is automatic";
  const n = Number(quarantineCooldownInput.value);
  return Number.isFinite(n) && n > 0 ? null : "Must be a positive number of minutes";
});

function saveQuarantineFn() {
  if (!quarantineEnabledInput.value) {
    savingQuarantine.value = true;
    emit("saveQuarantinePolicy", null);
    return;
  }
  if (quarantineThresholdError.value || quarantineCooldownError.value) return;
  savingQuarantine.value = true;
  emit("saveQuarantinePolicy", {
    consecutiveThreshold: Number(quarantineThresholdInput.value),
    action: quarantineActionInput.value,
    recoveryMode: quarantineRecoveryInput.value,
    cooldownMs:
      quarantineRecoveryInput.value === "auto" ? Math.round(Number(quarantineCooldownInput.value) * 60_000) : null,
  });
}

function clearQuarantineFn() {
  clearingQuarantine.value = true;
  emit("clearQuarantine");
}

watch(
  () => props.ws,
  (w) => {
    wsEnabledInput.value = Boolean(w?.enabled);
    wsUrlInput.value = w?.wsUrl ?? "";
    wsPersistentInput.value = w?.persistent ?? false;
    if (savingWs.value) {
      savingWs.value = false;
      flashSaved(savedWs);
    }
  },
);

const wsUrlError = computed(() => {
  if (!wsEnabledInput.value) return null;
  return /^wss?:\/\//.test(wsUrlInput.value.trim()) ? null : "Must start with ws:// or wss://";
});

function saveWsFn() {
  if (!wsEnabledInput.value) {
    savingWs.value = true;
    emit("saveWs", null);
    return;
  }
  if (wsUrlError.value) return;
  savingWs.value = true;
  emit("saveWs", { enabled: true, wsUrl: wsUrlInput.value.trim(), persistent: wsPersistentInput.value });
}

watch(
  () => props.graphql,
  (g) => {
    graphqlEnabledInput.value = Boolean(g?.enabled);
    graphqlQueryInput.value = g?.query ?? "";
    if (savingGraphql.value) {
      savingGraphql.value = false;
      flashSaved(savedGraphql);
    }
  },
);

function saveGraphqlFn() {
  if (!graphqlEnabledInput.value) {
    savingGraphql.value = true;
    emit("saveGraphql", null);
    return;
  }
  if (!graphqlQueryInput.value.trim()) return;
  savingGraphql.value = true;
  emit("saveGraphql", { enabled: true, query: graphqlQueryInput.value.trim() });
}

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
    if (savingContextBudget.value) {
      savingContextBudget.value = false;
      flashSaved(savedContextBudget);
    }
  },
);

const contextBudgetBytesError = computed(() => {
  if (!contextBudgetEnabledInput.value) return null;
  const n = Number(contextBudgetMaxBytesInput.value);
  return Number.isInteger(n) && n >= 256 ? null : "Must be a whole number of at least 256 bytes";
});

const contextBudgetLlmError = computed(() => {
  if (!contextBudgetEnabledInput.value || contextBudgetModeInput.value !== "llm_summarize") return null;
  if (!contextBudgetLlmBaseUrlInput.value.trim()) return "Base URL is required";
  if (!contextBudgetLlmModelInput.value.trim()) return "Model is required";
  if (!contextBudgetLlmApiKeyInput.value.trim()) return "API key is required";
  return null;
});

function saveContextBudgetFn() {
  if (!contextBudgetEnabledInput.value) {
    savingContextBudget.value = true;
    emit("saveContextBudget", null);
    return;
  }
  if (contextBudgetBytesError.value || contextBudgetLlmError.value) return;
  savingContextBudget.value = true;
  emit("saveContextBudget", {
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
  });
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
  const tags = tagsInput.value
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  savingTags.value = true;
  emit("saveTags", tags);
}

function saveRedactionFn() {
  const paths = redactInput.value
    .split(/[\n,]/)
    .map((p) => p.trim())
    .filter(Boolean);
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

    <h3>Presentation</h3>
    <div class="field">
      <label for="tool-display-name">Display name (alias)</label>
      <p class="hint">
        Renames the tool for MCP clients. The <code>{{ clientName ?? "client" }}__</code> prefix is always kept. Leave
        blank to use the registered name. Advertised as: <code>{{ advertisedName }}</code>
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
      <p class="hint">
        Replaces what MCP clients see for this tool in tools/list. Leave blank to use the registered description.
      </p>
      <textarea
        id="tool-desc"
        v-model="descriptionInput"
        rows="3"
        placeholder="Registered description is used when blank"
      ></textarea>
      <button
        type="button"
        class="btn-secondary desc-save"
        :disabled="saving || Boolean(displayNameError)"
        @click="saveOverrideFn"
      >
        {{ savingPresentation ? "Saving…" : "Save presentation" }}
      </button>
      <span v-if="savedPresentation" class="save-ok">Saved</span>
    </div>

    <h3>Tags</h3>
    <div class="field">
      <label for="tool-tags">Comma-separated tags</label>
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
      <p class="hint">
        One dot-path per line (e.g. user.ssn, items.*.secret). Matching JSON values are replaced with [REDACTED] before
        returning to the caller.
      </p>
      <textarea
        id="tool-redact"
        v-model="redactInput"
        rows="3"
        placeholder="user.password&#10;items.*.token"
      ></textarea>
      <button type="button" class="btn-secondary desc-save" :disabled="saving" @click="saveRedactionFn">
        {{ savingRedaction ? "Saving…" : "Save redaction" }}
      </button>
      <span v-if="savedRedaction" class="save-ok">Saved</span>
    </div>

    <h3><ShieldCheck :size="15" stroke-width="2" aria-hidden="true" /> Guardrails</h3>
    <div class="field">
      <label for="tool-deny">Content guardrails</label>
      <p class="hint">
        Input deny patterns (one regex per line). A call whose arguments match any pattern is rejected before dispatch.
      </p>
      <textarea
        id="tool-deny"
        v-model="denyPatternsInput"
        rows="2"
        placeholder="\bDROP\s+TABLE\b&#10;rm\s+-rf"
      ></textarea>
      <label class="checkline"
        ><input v-model="blockSecretsInput" type="checkbox" /> Block arguments that look like secrets (AWS keys, private
        keys, tokens…)</label
      >
      <label class="checkline"
        ><input v-model="scanResponsesInput" type="checkbox" /> Scan responses for prompt-injection and wrap flagged
        output</label
      >
      <button type="button" class="btn-secondary desc-save" :disabled="saving" @click="saveGuardrailsFn">
        {{ savingGuardrails ? "Saving…" : "Save guardrails" }}
      </button>
      <span v-if="savedGuardrails" class="save-ok">Saved</span>
    </div>

    <h3>Human-in-the-loop approval</h3>
    <div class="field">
      <label class="checkline"
        ><input v-model="approvalRequiredInput" type="checkbox" /> Require human approval before this tool runs</label
      >
      <label for="approval-levels">Distinct approvers required</label>
      <p class="hint">
        A call is only allowed once this many DIFFERENT admins/operators have approved it (1 = today's single-approval
        behavior). Any single rejection blocks the call immediately, regardless of prior approvals.
      </p>
      <input
        id="approval-levels"
        v-model="approvalLevelsInput"
        type="text"
        inputmode="numeric"
        :disabled="!approvalRequiredInput"
      />
      <p v-if="approvalRequiredInput && approvalLevelsError" class="field-error">{{ approvalLevelsError }}</p>
      <button
        type="button"
        class="btn-secondary desc-save"
        :disabled="saving || (approvalRequiredInput && Boolean(approvalLevelsError))"
        @click="saveApprovalFn"
      >
        {{ savingApproval ? "Saving…" : "Save approval settings" }}
      </button>
      <span v-if="savedApproval" class="save-ok">Saved</span>
    </div>

    <h3>Auto-quarantine</h3>
    <div class="field">
      <div v-if="quarantine?.state.quarantined" class="quarantine-banner">
        Currently quarantined{{ quarantine.state.reason ? `: ${quarantine.state.reason}` : "" }}
        <button type="button" class="link-btn" :disabled="saving" @click="clearQuarantineFn">
          {{ clearingQuarantine ? "Clearing…" : "Clear now" }}
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
        <select id="q-action" v-model="quarantineActionInput">
          <option value="block">Block calls (same as disabling the tool)</option>
          <option value="force_approval">Force every call through human approval</option>
          <option value="observe">Observe only — log and let calls through</option>
        </select>

        <label for="q-recovery">Recovery</label>
        <select id="q-recovery" v-model="quarantineRecoveryInput">
          <option value="manual">Manual only — an admin must clear it</option>
          <option value="auto">Automatic — clears itself after a cooldown</option>
        </select>

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
      <button
        type="button"
        class="btn-secondary desc-save"
        :disabled="saving || (quarantineEnabledInput && Boolean(quarantineThresholdError || quarantineCooldownError))"
        @click="saveQuarantineFn"
      >
        {{ savingQuarantine ? "Saving…" : "Save quarantine settings" }}
      </button>
      <span v-if="savedQuarantine" class="save-ok">Saved</span>
    </div>

    <h3>WebSocket backend</h3>
    <div class="field">
      <label class="checkline"
        ><input v-model="wsEnabledInput" type="checkbox" /> Dispatch this tool over a WebSocket instead of REST</label
      >
      <template v-if="wsEnabledInput">
        <label for="ws-url">WebSocket URL</label>
        <input id="ws-url" v-model="wsUrlInput" type="text" placeholder="wss://example.com/socket" />
        <p v-if="wsUrlError" class="field-error">{{ wsUrlError }}</p>
        <label class="checkline"
          ><input v-model="wsPersistentInput" type="checkbox" /> Persistent connection — forward every message as
          progress instead of closing after the first</label
        >
        <p class="hint">
          Non-persistent (default) opens a fresh connection per call and returns the first message. Persistent stays
          open and resolves with the last message once the connection closes or the timeout elapses — intermediate
          messages are forwarded as MCP progress notifications to callers that requested them.
        </p>
      </template>
      <button
        type="button"
        class="btn-secondary desc-save"
        :disabled="saving || (wsEnabledInput && Boolean(wsUrlError))"
        @click="saveWsFn"
      >
        {{ savingWs ? "Saving…" : "Save WebSocket settings" }}
      </button>
      <span v-if="savedWs" class="save-ok">Saved</span>
    </div>

    <h3>GraphQL backend</h3>
    <div class="field">
      <label class="checkline"
        ><input v-model="graphqlEnabledInput" type="checkbox" /> Dispatch this tool as a GraphQL query/mutation instead
        of a plain REST body</label
      >
      <template v-if="graphqlEnabledInput">
        <label for="graphql-query">GraphQL query/mutation</label>
        <textarea
          id="graphql-query"
          v-model="graphqlQueryInput"
          rows="6"
          spellcheck="false"
          placeholder="query my_tool($id: ID!) { pet(id: $id) { id name } }"
        ></textarea>
        <p class="hint">
          Tool-call arguments are sent as GraphQL variables — declare a <code>$var: Type</code> for each argument this
          tool's input schema accepts. Auto-discovered tools start with a synthesized query you can extend here (e.g.
          deeper selection sets).
        </p>
      </template>
      <button
        type="button"
        class="btn-secondary desc-save"
        :disabled="saving || (graphqlEnabledInput && !graphqlQueryInput.trim())"
        @click="saveGraphqlFn"
      >
        {{ savingGraphql ? "Saving…" : "Save GraphQL settings" }}
      </button>
      <span v-if="savedGraphql" class="save-ok">Saved</span>
    </div>

    <h3>Request coalescing</h3>
    <div class="field">
      <label class="checkline"
        ><input v-model="coalesceInput" type="checkbox" /> Share one upstream fetch across concurrent identical calls
        (GET tools only)</label
      >
      <p class="hint">
        Distinct from the response cache's TTL — only dedupes calls that are in flight at the same moment, so it's safe
        even without caching enabled.
      </p>
      <button type="button" class="btn-secondary desc-save" :disabled="saving" @click="saveCoalesceFn">
        {{ savingCoalesce ? "Saving…" : "Save coalescing" }}
      </button>
      <span v-if="savedCoalesce" class="save-ok">Saved</span>
    </div>

    <h3>Response cache</h3>
    <div class="field">
      <p class="hint">
        Clears any responses already cached for this tool. Doesn't change the cache's enabled/TTL config — new responses
        are cached again on the next matching call.
      </p>
      <button
        type="button"
        class="btn-secondary desc-save"
        :disabled="purgingCache || !clientName || !toolName"
        @click="purgeCacheFn"
      >
        <Eraser :size="14" stroke-width="2" aria-hidden="true" />
        {{ purgingCache ? "Purging…" : "Purge cached responses" }}
      </button>
      <span v-if="purgedCache" class="save-ok">Purged</span>
      <p v-if="purgeCacheError" class="field-error">{{ purgeCacheError }}</p>
    </div>

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
      <button
        type="button"
        class="btn-secondary desc-save"
        :disabled="saving || Boolean(contextBudgetBytesError || contextBudgetLlmError)"
        @click="saveContextBudgetFn"
      >
        {{ savingContextBudget ? "Saving…" : "Save context budget" }}
      </button>
      <span v-if="savedContextBudget" class="save-ok">Saved</span>
    </div>

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
.quarantine-banner {
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
.field select {
  width: 100%;
  padding: 0.45rem 0.6rem;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  font-size: 0.9rem;
  font-family: var(--font-body);
  box-sizing: border-box;
  margin-bottom: 0.5rem;
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
