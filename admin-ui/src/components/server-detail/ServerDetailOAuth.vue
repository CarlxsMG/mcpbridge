<script setup lang="ts">
import { ref, onMounted } from "vue";
import { api, ApiError } from "@/composables/useApi";
import { clientPath } from "@/utils/apiPaths";
import { useConfirmAction } from "@/composables/useConfirmAction";
import type { ClientOAuthConfig } from "@/types/api";
import ConfirmDialog from "@/components/ui/ConfirmDialog.vue";

const props = defineProps<{ clientName: string }>();

const oauth = ref<ClientOAuthConfig | null>(null);
const oauthEditing = ref(false);
const oauthTokenUrl = ref("");
const oauthClientId = ref("");
const oauthClientSecret = ref("");
const oauthScope = ref("");
const oauthSaving = ref(false);
const oauthError = ref("");

async function loadOAuth() {
  try {
    const res = await api.get<{ oauth: ClientOAuthConfig | null }>(clientPath(props.clientName, "oauth"));
    oauth.value = res.oauth;
  } catch {
    oauth.value = null;
  }
}
onMounted(loadOAuth);

async function saveOAuth() {
  oauthError.value = "";
  if (!oauthTokenUrl.value.trim() || !oauthClientId.value.trim() || !oauthClientSecret.value.trim()) {
    oauthError.value = "Token URL, client ID, and client secret are required.";
    return;
  }
  oauthSaving.value = true;
  try {
    await api.put(clientPath(props.clientName, "oauth"), {
      tokenUrl: oauthTokenUrl.value.trim(),
      clientId: oauthClientId.value.trim(),
      clientSecret: oauthClientSecret.value,
      scope: oauthScope.value.trim() || undefined,
    });
    oauthTokenUrl.value = "";
    oauthClientId.value = "";
    oauthClientSecret.value = "";
    oauthScope.value = "";
    oauthEditing.value = false;
    await loadOAuth();
  } catch (err) {
    oauthError.value = err instanceof ApiError ? err.message : "Failed to save OAuth config.";
  } finally {
    oauthSaving.value = false;
  }
}

const {
  pending: pendingClearOAuth,
  request: requestClearOAuthConfirm,
  cancel: cancelClearOAuth,
  confirm: confirmClearOAuthAction,
} = useConfirmAction<true>();

function requestClearOAuth() {
  requestClearOAuthConfirm(true);
}

function confirmClearOAuth() {
  return confirmClearOAuthAction(async () => {
    try {
      await api.put(clientPath(props.clientName, "oauth"), { oauth: null });
      oauth.value = null;
    } catch (err) {
      oauthError.value = err instanceof ApiError ? err.message : "Failed to clear OAuth config.";
    }
  });
}
</script>

<template>
  <div class="upstream-auth">
    <div class="ua-head">
      <h2>Upstream OAuth (client credentials)</h2>
      <div class="ua-actions">
        <button type="button" class="btn-secondary" @click="oauthEditing = !oauthEditing">
          {{ oauthEditing ? "Cancel" : oauth ? "Change" : "Set credentials" }}
        </button>
        <button v-if="oauth" type="button" class="link-btn danger" @click="requestClearOAuth">Clear</button>
      </div>
    </div>
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
      <p v-if="oauthError" class="error">{{ oauthError }}</p>
      <button type="submit" class="btn-primary" :disabled="oauthSaving">
        {{ oauthSaving ? "Saving…" : "Save OAuth config" }}
      </button>
    </form>
  </div>

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
