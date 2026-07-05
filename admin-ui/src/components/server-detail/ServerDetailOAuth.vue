<script setup lang="ts">
import { ref, onMounted } from "vue";
import { useI18n } from "vue-i18n";
import { api } from "@/composables/useApi";
import { clientPath } from "@/utils/apiPaths";
import { useClearableConfig } from "@/composables/useClearableConfig";
import { useResource } from "@/composables/useResource";
import { usePatchResource } from "@/composables/usePatchResource";
import { tk } from "@/i18n";
import type { ClientOAuthConfig } from "@/types/api";
import ConfirmDialog from "@/components/ui/ConfirmDialog.vue";
import ConfigSection from "./ConfigSection.vue";

const props = defineProps<{ clientName: string }>();
const { t } = useI18n({ useScope: "global" });

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
    oauthError.value = t("components.server_detail_oauth.errors.required_fields");
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
    tk("components.server_detail_oauth.errors.save_failed"),
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
  tk("components.server_detail_oauth.errors.clear_failed"),
);
</script>

<template>
  <ConfigSection :title="t('components.server_detail_oauth.title')">
    <template #actions>
      <button type="button" class="btn-secondary" @click="oauthEditing = !oauthEditing">
        {{ oauthEditing ? t('common.cancel') : oauth ? t('components.server_detail_oauth.change') : t('components.server_detail_oauth.set_credentials') }}
      </button>
      <button v-if="oauth" type="button" class="link-btn danger" @click="requestClearOAuth">{{ t('components.server_detail_oauth.clear') }}</button>
    </template>
    <p class="ua-status">
      <template v-if="oauth">
        {{ t('components.server_detail_oauth.configured') }}: <code>{{ oauth.tokenUrl }}</code> · {{ t('components.server_detail_oauth.client') }} <code>{{ oauth.clientId }}</code
        ><span v-if="oauth.scope">
          · {{ t('components.server_detail_oauth.scope') }} <code>{{ oauth.scope }}</code></span
        >
      </template>
      <template v-else>{{ t('components.server_detail_oauth.not_configured') }}</template>
    </p>
    <form v-if="oauthEditing" class="ua-form" @submit.prevent="saveOAuth">
      <label
        >{{ t('components.server_detail_oauth.fields.token_url') }}
        <input v-model="oauthTokenUrl" type="url" placeholder="https://auth.example.com/oauth/token" autocomplete="off"
      /></label>
      <label>{{ t('components.server_detail_oauth.fields.client_id') }} <input v-model="oauthClientId" autocomplete="off" /></label>
      <label>{{ t('components.server_detail_oauth.fields.client_secret') }} <input v-model="oauthClientSecret" type="password" autocomplete="off" /></label>
      <label>{{ t('components.server_detail_oauth.fields.scope') }} <input v-model="oauthScope" autocomplete="off" placeholder="read write" /></label>
      <p v-if="oauthError || clearOAuthError" class="error">{{ oauthError || clearOAuthError }}</p>
      <button type="submit" class="btn-primary" :disabled="oauthSaving">
        {{ oauthSaving ? t('common.saving') : t('components.server_detail_oauth.save') }}
      </button>
    </form>
  </ConfigSection>

  <ConfirmDialog
    :open="pendingClearOAuth !== null"
    :title="t('components.server_detail_oauth.confirm.clear_title')"
    :message="t('components.server_detail_oauth.confirm.clear_message')"
    :confirm-label="t('components.server_detail_oauth.confirm.clear_cta')"
    danger
    @confirm="confirmClearOAuth"
    @cancel="cancelClearOAuth"
  />
</template>