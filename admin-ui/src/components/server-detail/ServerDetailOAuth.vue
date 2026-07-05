<script setup lang="ts">
import { ref, onMounted } from "vue";
import { api } from "@/composables/useApi";
import { clientPath } from "@/utils/apiPaths";
import { useClearableConfig } from "@/composables/useClearableConfig";
import { useResource } from "@/composables/useResource";
import { usePatchResource } from "@/composables/usePatchResource";
import type { ClientOAuthConfig } from "@/types/api";
import ConfirmDialog from "@/components/ui/ConfirmDialog.vue";
import ConfigSection from "./ConfigSection.vue";

const props = defineProps<{ clientName: string }>();

const { data: oauth, load: loadOAuth } = useResource<ClientOAuthConfig | null>(
  () => api.get<{ oauth: ClientOAuthConfig | null }>(clientPath(props.clientName, "oauth")).then((res) => res.oauth),
  null,
);
onMounted(loadOAuth);

const oauthEditing = ref(false);
const oauthTokenUrl = ref("");
const oauthClientId = ref("");
const oauthClientSecret = ref("");
const oauthScope = ref("");

const {
  saving: oauthSaving,
  error: oauthError,
  run: runOAuth,
} = usePatchResource(() => clientPath(props.clientName, "oauth"));

async function saveOAuth() {
  if (!oauthTokenUrl.value.trim() || !oauthClientId.value.trim() || !oauthClientSecret.value.trim()) {
    oauthError.value = "Token URL, client ID, and client secret are required.";
    return;
  }
  const ok = await runOAuth(
    (path) =>
      api.put(path, {
        tokenUrl: oauthTokenUrl.value.trim(),
        clientId: oauthClientId.value.trim(),
        clientSecret: oauthClientSecret.value,
        scope: oauthScope.value.trim() || undefined,
      }),
    "Failed to save OAuth config.",
  );
  if (ok) {
    oauthTokenUrl.value = "";
    oauthClientId.value = "";
    oauthClientSecret.value = "";
    oauthScope.value = "";
    oauthEditing.value = false;
    await loadOAuth();
  }
}

const {
  pendingClear: pendingClearOAuth,
  requestClear: requestClearOAuth,
  cancelClear: cancelClearOAuth,
  confirmClear: confirmClearOAuth,
  error: clearOAuthError,
} = useClearableConfig(
  loadOAuth,
  () => api.put(clientPath(props.clientName, "oauth"), { oauth: null }),
  "Failed to clear OAuth config.",
);
</script>

<template>
  <ConfigSection title="Upstream OAuth (client credentials)">
    <template #actions>
      <button type="button" class="btn-secondary" @click="oauthEditing = !oauthEditing">
        {{ oauthEditing ? "Cancel" : oauth ? "Change" : "Set credentials" }}
      </button>
      <button v-if="oauth" type="button" class="link-btn danger" @click="requestClearOAuth">Clear</button>
    </template>
    <p class="ua-status">
      <template v-if="oauth">
        Configured: <code>{{ oauth.tokenUrl }}</code> · client <code>{{ oauth.clientId }}</code
        ><span v-if="oauth.scope">
          · scope <code>{{ oauth.scope }}</code></span
        >
      </template>
      <template v-else
        >Not configured — the bridge mints a token via client-credentials before each call and injects it as
        <code>Authorization: Bearer …</code>. The client secret is write-only and never shown again once
        saved.</template
      >
    </p>
    <form v-if="oauthEditing" class="ua-form" @submit.prevent="saveOAuth">
      <label
        >Token URL
        <input v-model="oauthTokenUrl" type="url" placeholder="https://auth.example.com/oauth/token" autocomplete="off"
      /></label>
      <label>Client ID <input v-model="oauthClientId" autocomplete="off" /></label>
      <label>Client secret <input v-model="oauthClientSecret" type="password" autocomplete="off" /></label>
      <label>Scope (optional) <input v-model="oauthScope" autocomplete="off" placeholder="read write" /></label>
      <p v-if="oauthError || clearOAuthError" class="error">{{ oauthError || clearOAuthError }}</p>
      <button type="submit" class="btn-primary" :disabled="oauthSaving">
        {{ oauthSaving ? "Saving…" : "Save OAuth config" }}
      </button>
    </form>
  </ConfigSection>

  <ConfirmDialog
    :open="pendingClearOAuth !== null"
    title="Clear OAuth client credentials?"
    message="This removes the stored token URL, client ID, and client secret. This can't be undone — outbound calls will stop injecting an OAuth bearer token until you set new credentials."
    confirm-label="Clear OAuth config"
    danger
    @confirm="confirmClearOAuth"
    @cancel="cancelClearOAuth"
  />
</template>
