<script setup lang="ts">
import { ref, computed, watch } from "vue";
import { useI18n } from "vue-i18n";
import { api } from "@/composables/useApi";
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
import CopyButton from "@/components/ui/CopyButton.vue";

const props = defineProps<{
  open: boolean;
  presetScope: ConnectScope;
  presetName?: string;
}>();
const emit = defineEmits<{ close: [] }>();
const { t } = useI18n({ useScope: "global" });

const CLIENT_OPTIONS = Object.values(CONNECT_TEMPLATES).map((tmpl) => ({ value: tmpl.id, label: tmpl.label }));

const SCOPE_OPTIONS: { value: ConnectScope; label: string }[] = [
  { value: "client", label: t("components.connect_client_dialog.scope.client") },
  { value: "bundle", label: t("components.connect_client_dialog.scope.bundle") },
  { value: "system", label: t("components.connect_client_dialog.scope.system") },
];

const clientId = ref<ConnectClientId>("claude-desktop");
const scope = ref<ConnectScope>(props.presetScope);
const targetName = ref(props.presetName ?? "");
const gatewayBaseUrl = ref("");

const clients = ref<ClientSummary[]>([]);
const bundles = ref<BundleSummary[]>([]);
const keyCount = ref<number | null>(null);

async function loadContext() {
  gatewayBaseUrl.value = window.location.origin;
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
  return [
    { value: "", label: t("components.connect_client_dialog.choose_one"), disabled: true },
    ...names.map((n) => ({ value: n, label: n })),
  ];
});

const targetCreatePath = computed(() => (scope.value === "client" ? "/register-server" : "/bundles/new"));
const targetCreateLabel = computed(() =>
  scope.value === "client"
    ? t("components.connect_client_dialog.create_server")
    : t("components.connect_client_dialog.create_bundle"),
);

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
</script>

<template>
  <ModalShell
    :open="open"
    :ariaLabel="t('components.connect_client_dialog.title')"
    :max-width="'40rem'"
    @close="emit('close')"
  >
    <div class="dialog-head">
      <h2>{{ t("components.connect_client_dialog.title") }}</h2>
      <button type="button" class="link-btn" @click="emit('close')">{{ t("common.close") }}</button>
    </div>
    <p class="hint">
      {{ t("components.connect_client_dialog.hint") }}
    </p>

    <div class="form-grid">
      <label
        >{{ t("components.connect_client_dialog.fields.client") }}
        <SelectMenu v-model="clientId" :options="CLIENT_OPTIONS" />
      </label>

      <label
        >{{ t("components.connect_client_dialog.fields.connect_to") }}
        <SelectMenu v-model="scope" :options="SCOPE_OPTIONS" />
      </label>

      <label v-if="scope !== 'system'"
        >{{
          scope === "client"
            ? t("components.connect_client_dialog.fields.server")
            : t("components.connect_client_dialog.fields.bundle")
        }}
        <SelectMenu
          v-model="targetName"
          :options="targetSelectOptions"
          :create-path="targetCreatePath"
          :create-label="targetCreateLabel"
          :reload="loadContext"
        />
      </label>

      <label
        >{{ t("components.connect_client_dialog.fields.gateway_url") }}
        <input v-model="gatewayBaseUrl" type="url" placeholder="https://gateway.example.com" />
      </label>
    </div>

    <p v-if="keyCount === 0" class="key-warning">
      {{ t("components.connect_client_dialog.key_warning") }}
      <RouterLink to="/keys/new" @click="emit('close')">{{
        t("components.connect_client_dialog.create_one")
      }}</RouterLink>
      {{ t("components.connect_client_dialog.key_warning_after") }}
    </p>
    <p v-else-if="keyCount !== null" class="key-hint">
      {{ t("components.connect_client_dialog.key_count", { count: keyCount }) }}
      <code>{{ API_KEY_PLACEHOLDER }}</code>
      {{ t("components.connect_client_dialog.key_count_after") }}
      <RouterLink to="/keys" @click="emit('close')">{{ t("nav.keys.label") }}</RouterLink
      >.
    </p>

    <template v-if="result">
      <div class="snippet-head">
        <span>{{ result.filename }}</span>
        <CopyButton :text="result.snippet" :label="t('common.copy_to_clipboard')" />
      </div>
      <pre class="snippet" tabindex="0">{{ result.snippet }}</pre>

      <h3>{{ t("components.connect_client_dialog.setup") }}</h3>
      <ol class="instructions">
        <li v-for="(line, i) in result.instructions" :key="i">{{ line }}</li>
      </ol>
    </template>
    <p v-else class="hint">
      {{
        t("components.connect_client_dialog.choose_target", {
          kind:
            scope === "bundle"
              ? t("components.connect_client_dialog.fields.bundle")
              : t("components.connect_client_dialog.fields.server"),
        })
      }}
    </p>
  </ModalShell>
</template>

<style scoped>
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
