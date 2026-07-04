<script setup lang="ts">
import { ref, computed, watch, nextTick } from "vue";
import { api } from "../composables/useApi";
import { useClipboard } from "../composables/useClipboard";
import type { ClientSummary, BundleSummary, McpApiKey } from "../types/api";
import {
  CONNECT_TEMPLATES,
  resolveGatewayEndpoint,
  generateConnectSnippet,
  type ConnectClientId,
  type ConnectScope,
} from "@/utils/connectTemplates";
import { Copy, Check } from "lucide-vue-next";

const props = defineProps<{
  open: boolean;
  /** Preselects the scope + target when opened from a specific server/bundle page. */
  presetScope: ConnectScope;
  presetName?: string;
}>();
const emit = defineEmits<{ close: [] }>();

const CLIENT_OPTIONS = Object.values(CONNECT_TEMPLATES).map((t) => ({ id: t.id, label: t.label }));

const clientId = ref<ConnectClientId>("claude-desktop");
const scope = ref<ConnectScope>(props.presetScope);
const targetName = ref(props.presetName ?? "");
const gatewayBaseUrl = ref("");

const clients = ref<ClientSummary[]>([]);
const bundles = ref<BundleSummary[]>([]);
const keyCount = ref<number | null>(null);
const { copied, copy, reset } = useClipboard();
const dialogEl = ref<HTMLElement | null>(null);
const closeBtn = ref<HTMLButtonElement | null>(null);
let previouslyFocused: HTMLElement | null = null;

async function loadContext() {
  gatewayBaseUrl.value = window.location.origin;
  // Best-effort — an operator-declared public URL (GATEWAY_PUBLIC_URL) takes
  // priority over window.location.origin when set (e.g. the admin UI and the
  // gateway's externally-reachable URL differ behind a reverse proxy); the
  // field stays editable either way, so a failure here just falls back to
  // window.location.origin already set above.
  try {
    const res = await api.get<{ publicUrl: string | null }>("/admin-api/connect/gateway-url");
    if (res.publicUrl) gatewayBaseUrl.value = res.publicUrl;
  } catch {
    /* keep window.location.origin */
  }
  try {
    const res = await api.get<{ items: ClientSummary[] }>("/admin-api/clients?limit=200");
    clients.value = res.items;
  } catch {
    clients.value = [];
  }
  try {
    const res = await api.get<{ items: BundleSummary[] }>("/admin-api/bundles");
    bundles.value = res.items;
  } catch {
    bundles.value = [];
  }
  try {
    const res = await api.get<{ items: McpApiKey[] }>("/admin-api/mcp-keys");
    keyCount.value = res.items.filter((k) => k.enabled && k.revokedAt === null).length;
  } catch {
    keyCount.value = null;
  }
}

watch(
  () => props.open,
  async (isOpen) => {
    if (isOpen) {
      scope.value = props.presetScope;
      targetName.value = props.presetName ?? "";
      reset();
      previouslyFocused = document.activeElement as HTMLElement | null;
      await loadContext();
      await nextTick();
      closeBtn.value?.focus();
    } else {
      previouslyFocused?.focus();
      previouslyFocused = null;
    }
  },
);

const targetOptions = computed(() =>
  scope.value === "client"
    ? clients.value.map((c) => c.name)
    : scope.value === "bundle"
      ? bundles.value.map((b) => b.name)
      : [],
);

// Snippets never carry a real key — always a clearly-marked placeholder the
// user swaps out by hand (see the module doc comment in connectTemplates.ts).
const API_KEY_PLACEHOLDER = "<YOUR_MCP_API_KEY>";

const result = computed(() => {
  if ((scope.value === "client" || scope.value === "bundle") && !targetName.value) return null;
  const base = (gatewayBaseUrl.value || window.location.origin).trim();
  if (!base) return null;
  let url: string;
  try {
    url = resolveGatewayEndpoint(base, scope.value, targetName.value || undefined);
  } catch {
    return null;
  }
  return generateConnectSnippet(clientId.value, {
    name: targetName.value || "gateway",
    url,
    transport: "streamable-http",
    apiKeyPlaceholder: API_KEY_PLACEHOLDER,
  });
});

async function copySnippet() {
  if (!result.value) return;
  await copy(result.value.snippet);
}

function trapFocus(e: KeyboardEvent) {
  if (e.key !== "Tab" || !dialogEl.value) return;
  const focusable = dialogEl.value.querySelectorAll<HTMLElement>(
    'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
  );
  if (focusable.length === 0) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}
</script>

<template>
  <div v-if="open" class="overlay" @keydown.esc.stop="emit('close')" @keydown="trapFocus">
    <div ref="dialogEl" class="dialog" role="dialog" aria-modal="true" aria-label="Connect a client">
      <div class="dialog-head">
        <h2>Connect a client</h2>
        <button ref="closeBtn" type="button" class="link-btn" @click="emit('close')">Close</button>
      </div>
      <p class="hint">
        Generate a ready-to-paste MCP connection config for this gateway. Nothing here is saved or sent anywhere — it's
        assembled entirely in your browser.
      </p>

      <div class="form-grid">
        <label
          >Client
          <select v-model="clientId">
            <option v-for="opt in CLIENT_OPTIONS" :key="opt.id" :value="opt.id">{{ opt.label }}</option>
          </select>
        </label>

        <label
          >Connect to
          <select v-model="scope">
            <option value="client">A single server</option>
            <option value="bundle">A curated bundle</option>
            <option value="aggregated">Everything (aggregated /mcp)</option>
          </select>
        </label>

        <label v-if="scope !== 'aggregated'"
          >{{ scope === "client" ? "Server" : "Bundle" }}
          <select v-model="targetName">
            <option value="" disabled>— choose one —</option>
            <option v-for="n in targetOptions" :key="n" :value="n">{{ n }}</option>
          </select>
        </label>

        <label
          >Gateway URL
          <input v-model="gatewayBaseUrl" type="url" placeholder="https://gateway.example.com" />
        </label>
      </div>

      <p v-if="keyCount === 0" class="key-warning">
        You don't have an active MCP API key yet. <RouterLink to="/keys" @click="emit('close')">Create one</RouterLink>
        first, then come back and paste it in below.
      </p>
      <p v-else-if="keyCount !== null" class="key-hint">
        You have {{ keyCount }} active MCP API key{{ keyCount === 1 ? "" : "s" }} — paste one in place of
        <code>{{ API_KEY_PLACEHOLDER }}</code> below. Manage them under
        <RouterLink to="/keys" @click="emit('close')">API keys</RouterLink>.
      </p>

      <template v-if="result">
        <div class="snippet-head">
          <span>{{ result.filename }}</span>
          <button type="button" class="btn-secondary copy-btn" @click="copySnippet">
            <Check v-if="copied" :size="14" stroke-width="2" aria-hidden="true" />
            <Copy v-else :size="14" stroke-width="2" aria-hidden="true" />
            {{ copied ? "Copied" : "Copy to clipboard" }}
          </button>
        </div>
        <pre class="snippet" tabindex="0">{{ result.snippet }}</pre>

        <h3>Setup</h3>
        <ol class="instructions">
          <li v-for="(line, i) in result.instructions" :key="i">{{ line }}</li>
        </ol>
      </template>
      <p v-else class="hint">Choose a {{ scope === "bundle" ? "bundle" : "server" }} above to generate its config.</p>
    </div>
  </div>
</template>

<style scoped>
.overlay {
  position: fixed;
  inset: 0;
  background: rgba(14, 17, 22, 0.55);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: var(--z-overlay);
  padding: var(--space-4);
}
.dialog {
  background: var(--surface);
  border-radius: var(--radius-lg);
  padding: var(--space-6);
  max-width: 40rem;
  width: 100%;
  max-height: 90vh;
  overflow-y: auto;
  box-shadow: var(--shadow-lg);
}
.dialog-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: var(--space-3);
  margin-bottom: var(--space-2);
}
.dialog-head h2 {
  margin: 0;
  font-size: var(--text-lg);
}
.hint {
  color: var(--text-secondary);
  font-size: var(--text-sm);
  margin: 0 0 var(--space-4);
  line-height: 1.4;
}
.form-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--space-3);
  margin-bottom: var(--space-4);
}
.form-grid label {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  font-size: var(--text-sm);
  font-weight: 600;
}
.form-grid input,
.form-grid select {
  padding: 0.45rem 0.6rem;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  font-weight: 400;
  font-family: var(--font-body);
  font-size: var(--text-base);
  background: var(--surface);
  color: var(--text-primary);
}
.key-warning {
  background: var(--canary-soft);
  color: var(--text-primary);
  border-radius: var(--radius-sm);
  padding: var(--space-2) var(--space-3);
  font-size: var(--text-sm);
  margin: 0 0 var(--space-4);
}
.key-hint {
  color: var(--text-secondary);
  font-size: var(--text-sm);
  margin: 0 0 var(--space-4);
}
.snippet-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: var(--text-sm);
  font-weight: 600;
  color: var(--text-secondary);
  margin-bottom: var(--space-1-5);
}
.copy-btn {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1-5);
  padding: 0.3rem 0.7rem;
  font-size: var(--text-sm);
}
.snippet {
  background: var(--surface-sunken);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  padding: var(--space-3);
  font-family: var(--font-mono);
  font-size: 0.8rem;
  line-height: 1.5;
  overflow-x: auto;
  white-space: pre;
  margin: 0 0 var(--space-4);
}
h3 {
  font-size: var(--text-base);
  margin: 0 0 var(--space-2);
}
.instructions {
  margin: 0;
  padding-left: 1.2rem;
  font-size: var(--text-sm);
  color: var(--text-secondary);
  line-height: 1.6;
}
</style>
