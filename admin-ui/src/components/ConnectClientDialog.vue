<script setup lang="ts">
import { ref, computed, watch } from "vue";
import { api } from "@/composables/useApi";
import { useClipboard } from "@/composables/useClipboard";
import type { ClientSummary, BundleSummary, McpApiKey } from "@/types/api";
import {
  CONNECT_TEMPLATES,
  resolveGatewayEndpoint,
  generateConnectSnippet,
  type ConnectClientId,
  type ConnectScope,
} from "@/utils/connectTemplates";
import ModalShell from "@/components/ui/ModalShell.vue";
import SelectMenu from "@/components/ui/SelectMenu.vue";
import { Copy, Check } from "lucide-vue-next";

const props = defineProps<{
  open: boolean;
  /** Preselects the scope + target when opened from a specific server/bundle page. */
  presetScope: ConnectScope;
  presetName?: string;
}>();
const emit = defineEmits<{ close: [] }>();

const CLIENT_OPTIONS = Object.values(CONNECT_TEMPLATES).map((t) => ({ value: t.id, label: t.label }));

const SCOPE_OPTIONS: { value: ConnectScope; label: string }[] = [
  { value: "client", label: "A single server" },
  { value: "bundle", label: "A curated bundle" },
  { value: "aggregated", label: "Everything (aggregated /mcp)" },
];

const clientId = ref<ConnectClientId>("claude-desktop");
const scope = ref<ConnectScope>(props.presetScope);
const targetName = ref(props.presetName ?? "");
const gatewayBaseUrl = ref("");

const clients = ref<ClientSummary[]>([]);
const bundles = ref<BundleSummary[]>([]);
const keyCount = ref<number | null>(null);
const { copied, copy, reset } = useClipboard();

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

// Data-loading side effect only — ModalShell owns focus management (initial
// focus into the panel on open, focus-restore on close) for this dialog now.
watch(
  () => props.open,
  async (isOpen) => {
    if (isOpen) {
      scope.value = props.presetScope;
      targetName.value = props.presetName ?? "";
      reset();
      await loadContext();
    }
  },
);

const targetSelectOptions = computed(() => {
  const names =
    scope.value === "client"
      ? clients.value.map((c) => c.name)
      : scope.value === "bundle"
        ? bundles.value.map((b) => b.name)
        : [];
  return [{ value: "", label: "— choose one —", disabled: true }, ...names.map((n) => ({ value: n, label: n }))];
});

// Target create destination follows scope: a "server" here is a registered
// upstream client (see clients.value above), not an MCP client app.
const targetCreatePath = computed(() => (scope.value === "client" ? "/register-server" : "/bundles/new"));
const targetCreateLabel = computed(() => (scope.value === "client" ? "Add server" : "Create bundle"));

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
</script>

<template>
  <!-- :ariaLabel kept camelCase (not :aria-label): vue-tsc treats the hyphenated form as the
       built-in ARIA passthrough attribute rather than resolving it to ModalShell's ariaLabel prop -->
  <!-- eslint-disable-next-line vue/attribute-hyphenation -->
  <ModalShell :open="open" :ariaLabel="'Connect a client'" :max-width="'40rem'" @close="emit('close')">
    <div class="dialog-head">
      <h2>Connect a client</h2>
      <button type="button" class="link-btn" @click="emit('close')">Close</button>
    </div>
    <p class="hint">
      Generate a ready-to-paste MCP connection config for this gateway. Nothing here is saved or sent anywhere — it's
      assembled entirely in your browser.
    </p>

    <div class="form-grid">
      <label
        >Client
        <SelectMenu v-model="clientId" :options="CLIENT_OPTIONS" />
      </label>

      <label
        >Connect to
        <SelectMenu v-model="scope" :options="SCOPE_OPTIONS" />
      </label>

      <label v-if="scope !== 'aggregated'"
        >{{ scope === "client" ? "Server" : "Bundle" }}
        <SelectMenu
          v-model="targetName"
          :options="targetSelectOptions"
          :create-path="targetCreatePath"
          :create-label="targetCreateLabel"
          :reload="loadContext"
        />
      </label>

      <label
        >Gateway URL
        <input v-model="gatewayBaseUrl" type="url" placeholder="https://gateway.example.com" />
      </label>
    </div>

    <p v-if="keyCount === 0" class="key-warning">
      You don't have an active MCP API key yet.
      <RouterLink to="/keys/new" @click="emit('close')">Create one</RouterLink>
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
  </ModalShell>
</template>

<style scoped>
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
.form-grid input {
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
