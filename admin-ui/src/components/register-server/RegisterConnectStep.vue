<script setup lang="ts">
/**
 * The step that closes the registration loop: the server exists, now hand the
 * user a config their assistant will actually accept.
 *
 * Before this, a successful registration navigated straight to the server's
 * detail page, and connecting meant knowing to go mint a key under "API keys"
 * and then find the "Connect client" dialog. Everything needed is available
 * here — so it mints a key scoped to the client just created and renders the
 * snippet inline.
 *
 * The templates come from `@/utils/connectTemplates`, which is GENERATED from
 * src/cli/connect-templates.ts (`bun run check` fails on drift). Neither file
 * may be edited to suit this component.
 */
import { computed, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { api } from "@/composables/useApi";
import { toErrorMessage } from "@/utils/errors";
import { tk } from "@/i18n";
import type { McpApiKeyWithSecret } from "@/types/api";
import {
  CONNECT_TEMPLATES,
  generateConnectSnippet,
  resolveGatewayEndpoint,
  type ConnectClientId,
} from "@/utils/connectTemplates";
import SelectMenu from "@/components/ui/SelectMenu.vue";
import CopyButton from "@/components/ui/CopyButton.vue";
import FieldError from "@/components/ui/FieldError.vue";

const props = defineProps<{ serverName: string; toolsCount: number }>();
const emit = defineEmits<{ addAnother: [] }>();

const { t } = useI18n({ useScope: "global" });

const CLIENT_OPTIONS = Object.values(CONNECT_TEMPLATES).map((tmpl) => ({ value: tmpl.id, label: tmpl.label }));

/**
 * Stand-in shown until a key is minted here — and permanently when minting is
 * refused (it needs the admin role, while registering only needs operator, so an
 * operator reaches this step legitimately and must still get a usable snippet).
 * Same placeholder the Connect-client dialog uses, so the generated "replace
 * this" instruction line stays true.
 */
const API_KEY_PLACEHOLDER = "<YOUR_MCP_API_KEY>";

const clientId = ref<ConnectClientId>("claude-desktop");
const gatewayBaseUrl = ref("");
const mintedKey = ref<string | null>(null);
const mintError = ref("");
const minting = ref(false);
const loading = ref(true);

const mintFallback = tk("pages.register_server.connect.mint_failed");

async function loadGatewayUrl() {
  gatewayBaseUrl.value = window.location.origin;
  try {
    const res = await api.get<{ publicUrl: string | null }>("/admin-api/connect/gateway-url");
    if (res.publicUrl) gatewayBaseUrl.value = res.publicUrl;
  } catch {
    /* window.location.origin is the correct fallback — the admin UI is served by the gateway */
  }
}

/**
 * Minting is a button, not something this step does on render. Two reasons, one
 * of them load-bearing: creating a credential is a side effect the user should
 * ask for (every registration would otherwise leave a key behind, used or not),
 * and the data plane runs in "open mode" until the FIRST managed key exists
 * anywhere — so silently minting one here would flip a process-wide auth mode
 * as a side effect of visiting a page.
 */
async function mintKey() {
  mintError.value = "";
  minting.value = true;
  try {
    // Scoped to this one client: an unscoped key would reach every other
    // tenant's tools, and the backend refuses to mint one for a team-scoped
    // admin anyway (scopeConfinementError in routes/admin/mcp-keys.ts).
    const res = await api.post<McpApiKeyWithSecret>("/admin-api/mcp-keys", {
      // Deliberately not localized: this is stored data an operator later reads
      // on the Keys page, not interface copy, and it should not change meaning
      // with whoever happened to create the server.
      label: `${props.serverName} quick connect`,
      scopes: { clients: [props.serverName] },
    });
    mintedKey.value = res.key;
  } catch (err) {
    mintError.value = toErrorMessage(err, mintFallback);
  } finally {
    minting.value = false;
  }
}

onMounted(async () => {
  await loadGatewayUrl();
  loading.value = false;
});

const snippetKey = computed(() => mintedKey.value ?? API_KEY_PLACEHOLDER);

const result = computed(() => {
  const base = (gatewayBaseUrl.value || window.location.origin).trim();
  if (!base) return null;
  let url: string;
  try {
    url = resolveGatewayEndpoint(base, "client", props.serverName);
  } catch {
    return null;
  }
  return generateConnectSnippet(clientId.value, {
    name: props.serverName,
    url,
    transport: "streamable-http",
    apiKeyPlaceholder: snippetKey.value,
    scope: "client",
  });
});

/**
 * Drops the template's "replace the placeholder with a real key" step once a
 * real key IS in the snippet. Matching on "does this line contain the key we
 * passed in" rather than on the sentence keeps working when the generated
 * wording changes, and has the second effect of never printing the credential
 * in a line with no copy affordance.
 */
const instructions = computed(() => {
  const lines = result.value?.instructions ?? [];
  if (!mintedKey.value) return lines;
  return lines.filter((line) => !line.includes(snippetKey.value));
});
</script>

<template>
  <div class="connect">
    <h2>{{ t("pages.register_server.connect.title", { name: serverName }) }}</h2>
    <p class="tools-line">
      {{ t("pages.register_server.preview_count", { count: toolsCount }, toolsCount) }}
    </p>

    <label class="client-pick"
      >{{ t("components.connect_client_dialog.fields.client") }}
      <SelectMenu
        v-model="clientId"
        :options="CLIENT_OPTIONS"
        :aria-label="t('components.connect_client_dialog.fields.client')"
      />
    </label>

    <p v-if="loading" class="hint">{{ t("pages.register_server.connect.preparing") }}</p>
    <template v-else-if="mintedKey">
      <p class="key-note">{{ t("pages.register_server.connect.key_minted") }}</p>
    </template>
    <div v-else class="key-row">
      <button type="button" class="btn-secondary" :disabled="minting" @click="mintKey">
        {{ minting ? t("pages.register_server.connect.minting") : t("pages.register_server.connect.mint_key") }}
      </button>
      <span class="hint">{{ t("pages.register_server.connect.key_hint") }}</span>
    </div>
    <FieldError :message="mintError" />

    <template v-if="result">
      <div class="snippet-head">
        <span>{{ result.filename }}</span>
        <CopyButton :text="result.snippet" :label="t('common.copy_to_clipboard')" />
      </div>
      <pre class="snippet" tabindex="0">{{ result.snippet }}</pre>

      <h3>{{ t("components.connect_client_dialog.setup") }}</h3>
      <ol class="instructions">
        <li v-for="(line, i) in instructions" :key="i">{{ line }}</li>
      </ol>
    </template>

    <div class="actions">
      <RouterLink :to="`/servers/${encodeURIComponent(serverName)}`" class="btn-primary">{{
        t("pages.register_server.connect.go_to_server")
      }}</RouterLink>
      <!-- A RouterLink back to /servers/new would be a no-op navigation (this IS
           that route), so resetting is the parent's job. -->
      <button type="button" class="link-btn" @click="emit('addAnother')">
        {{ t("pages.register_server.connect.add_another") }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.connect {
  background: var(--surface);
  border: 1px solid var(--ok);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-xs);
  padding: 1.25rem;
  margin: 1rem 0;
}
.connect h2 {
  font-size: var(--text-lg);
  margin: 0 0 var(--space-1);
}
.tools-line {
  color: var(--ok-text);
  font-size: var(--text-sm);
  font-weight: 600;
  margin: 0 0 var(--space-4);
}
.client-pick {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  font-size: var(--text-sm);
  font-weight: 600;
  max-width: 18rem;
  margin-bottom: var(--space-3);
}
.key-note {
  color: var(--text-secondary);
  font-size: var(--text-sm);
  margin: 0 0 var(--space-3);
}
.key-row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  flex-wrap: wrap;
  margin-bottom: var(--space-3);
}
.key-row .hint {
  margin: 0;
}
.hint {
  color: var(--text-secondary);
  font-size: var(--text-sm);
  margin: 0 0 var(--space-3);
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
.connect h3 {
  font-size: var(--text-base);
  margin: 0 0 var(--space-2);
}
.instructions {
  margin: 0 0 var(--space-4);
  padding-left: 1.2rem;
  font-size: var(--text-sm);
  color: var(--text-secondary);
  line-height: 1.6;
}
.actions {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}
</style>
