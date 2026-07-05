<script setup lang="ts">
import { ref } from "vue";
import { useI18n } from "vue-i18n";
import { useRouter } from "vue-router";
import { api } from "@/composables/useApi";
import { parseOptionalNumber } from "@/utils/fieldParsing";
import { toErrorMessage } from "@/utils/errors";
import { tk } from "@/i18n";
import PageHeader from "@/components/ui/PageHeader.vue";
import FormField from "@/components/ui/FormField.vue";
import FormPage from "@/components/ui/FormPage.vue";

const { t } = useI18n({ useScope: "global" });

const router = useRouter();

const name = ref("");
const backendUrl = ref("");
const maxConnections = ref("");
const maxMessageBytes = ref("");
const idleTimeoutMinutes = ref("");
const error = ref("");
const creating = ref(false);

async function createTarget() {
  error.value = "";
  if (!name.value.trim() || !backendUrl.value.trim()) {
    error.value = t("pages.ws_proxy_targets.errors.name_and_url_required");
    return;
  }
  const maxConnectionsResult = parseOptionalNumber(
    maxConnections.value,
    t("pages.ws_proxy_targets.errors.max_connections_invalid"),
  );
  const maxMessageBytesResult = parseOptionalNumber(
    maxMessageBytes.value,
    t("pages.ws_proxy_targets.errors.max_message_bytes_invalid"),
  );
  const idleTimeoutMinutesResult = parseOptionalNumber(
    idleTimeoutMinutes.value,
    t("pages.ws_proxy_targets.errors.idle_timeout_invalid"),
  );
  for (const result of [maxConnectionsResult, maxMessageBytesResult, idleTimeoutMinutesResult]) {
    if (result.error) {
      error.value = result.error;
      return;
    }
  }
  creating.value = true;
  try {
    const body: Record<string, unknown> = { name: name.value.trim(), backendWsUrl: backendUrl.value.trim() };
    if (maxConnectionsResult.value !== null) body.maxConnections = maxConnectionsResult.value;
    if (maxMessageBytesResult.value !== null) body.maxMessageBytes = maxMessageBytesResult.value;
    if (idleTimeoutMinutesResult.value !== null) body.idleTimeoutMs = idleTimeoutMinutesResult.value * 60_000;
    await api.post("/admin-api/ws-proxy-targets", body);
    await router.push("/ws-proxies");
  } catch (err) {
    error.value = toErrorMessage(err, tk("pages.ws_proxy_targets.errors.create_failed"));
  } finally {
    creating.value = false;
  }
}
</script>

<template>
  <section>
    <FormPage max-width="26.25rem">
      <PageHeader :title="t('pages.ws_proxy_targets.new.title')" :back-link="{ to: '/ws-proxies', label: t('nav.ws_proxies') }" />

      <form class="form-card" @submit.prevent="createTarget">
        <FormField :label="t('pages.ws_proxy_targets.fields.name')" for="wp-name">
          <input id="wp-name" v-model="name" type="text" :placeholder="t('pages.ws_proxy_targets.placeholders.name')" />
        </FormField>
        <FormField :label="t('pages.ws_proxy_targets.fields.backend_url')" for="wp-url">
          <input id="wp-url" v-model="backendUrl" type="text" :placeholder="t('pages.ws_proxy_targets.placeholders.backend_url')" />
        </FormField>
        <FormField :label="t('pages.ws_proxy_targets.fields.max_connections')" for="wp-max-conn">
          <input id="wp-max-conn" v-model="maxConnections" type="text" inputmode="numeric" />
        </FormField>
        <FormField :label="t('pages.ws_proxy_targets.fields.max_message_bytes')" for="wp-max-bytes">
          <input id="wp-max-bytes" v-model="maxMessageBytes" type="text" inputmode="numeric" />
        </FormField>
        <FormField :label="t('pages.ws_proxy_targets.fields.idle_timeout')" for="wp-idle">
          <input id="wp-idle" v-model="idleTimeoutMinutes" type="text" inputmode="numeric" />
        </FormField>
        <p v-if="error" class="error">{{ error }}</p>
        <button type="submit" class="btn-primary" :disabled="creating">
          {{ creating ? t('common.creating') : t('pages.ws_proxy_targets.new.create') }}
        </button>
      </form>
    </FormPage>
  </section>
</template>