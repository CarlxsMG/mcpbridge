<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { api } from "@/composables/useApi";
import { useCreateForm } from "@/composables/useCreateForm";
import { useUnsavedChangesGuard } from "@/composables/useUnsavedChangesGuard";
import { parseOptionalNumber } from "@/utils/fieldParsing";
import PageHeader from "@/components/ui/PageHeader.vue";
import FormField from "@/components/ui/FormField.vue";
import FormPage from "@/components/ui/FormPage.vue";
import FieldError from "@/components/ui/FieldError.vue";
import ConfirmDialog from "@/components/ui/ConfirmDialog.vue";

const { t } = useI18n({ useScope: "global" });

const name = ref("");
const backendUrl = ref("");
const maxConnections = ref("");
const maxMessageBytes = ref("");
const idleTimeoutMinutes = ref("");

const { creating, error, run } = useCreateForm({
  submit: () => {
    const body: Record<string, unknown> = { name: name.value.trim(), backendWsUrl: backendUrl.value.trim() };
    const maxConnectionsValue = parseOptionalNumber(maxConnections.value).value;
    const maxMessageBytesValue = parseOptionalNumber(maxMessageBytes.value).value;
    const idleTimeoutMinutesValue = parseOptionalNumber(idleTimeoutMinutes.value).value;
    if (maxConnectionsValue !== null) body.maxConnections = maxConnectionsValue;
    if (maxMessageBytesValue !== null) body.maxMessageBytes = maxMessageBytesValue;
    if (idleTimeoutMinutesValue !== null) body.idleTimeoutMs = idleTimeoutMinutesValue * 60_000;
    return api.post("/admin-api/ws-proxy-targets", body);
  },
  redirectTo: "/ws-proxies",
  fallbackKey: "pages.ws_proxy_targets.errors.create_failed",
});

function createTarget() {
  return run(() => {
    if (!name.value.trim() || !backendUrl.value.trim()) {
      return t("pages.ws_proxy_targets.errors.name_and_url_required");
    }
    const results = [
      parseOptionalNumber(maxConnections.value, t("pages.ws_proxy_targets.errors.max_connections_invalid")),
      parseOptionalNumber(maxMessageBytes.value, t("pages.ws_proxy_targets.errors.max_message_bytes_invalid")),
      parseOptionalNumber(idleTimeoutMinutes.value, t("pages.ws_proxy_targets.errors.idle_timeout_invalid")),
    ];
    for (const result of results) {
      if (result.error) return result.error;
    }
    return null;
  });
}

const isDirty = computed(
  () =>
    Boolean(name.value.trim()) ||
    Boolean(backendUrl.value.trim()) ||
    Boolean(maxConnections.value.trim()) ||
    Boolean(maxMessageBytes.value.trim()) ||
    Boolean(idleTimeoutMinutes.value.trim()),
);
const { pendingLeave, confirmLeave, cancelLeave } = useUnsavedChangesGuard(isDirty, () => creating.value);
</script>

<template>
  <section>
    <FormPage max-width="26.25rem">
      <PageHeader
        :title="t('pages.ws_proxy_targets.new.title')"
        :back-link="{ to: '/ws-proxies', label: t('nav.ws-proxies.label') }"
      />

      <form class="form-card" @submit.prevent="createTarget">
        <FormField :label="t('pages.ws_proxy_targets.fields.name')" for="wp-name">
          <input id="wp-name" v-model="name" type="text" :placeholder="t('pages.ws_proxy_targets.placeholders.name')" />
        </FormField>
        <FormField :label="t('pages.ws_proxy_targets.fields.backend_url')" for="wp-url">
          <input
            id="wp-url"
            v-model="backendUrl"
            type="text"
            :placeholder="t('pages.ws_proxy_targets.placeholders.backend_url')"
          />
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
        <FieldError :message="error" />
        <button type="submit" class="btn-primary" :disabled="creating">
          {{ creating ? t("common.creating") : t("pages.ws_proxy_targets.new.create") }}
        </button>
      </form>
    </FormPage>

    <ConfirmDialog
      :open="pendingLeave"
      :title="t('pages.ws_proxy_targets.confirm.leave_title')"
      :message="t('pages.ws_proxy_targets.confirm.leave_message')"
      :confirm-label="t('pages.ws_proxy_targets.confirm.leave_cta')"
      danger
      @confirm="confirmLeave"
      @cancel="cancelLeave"
    />
  </section>
</template>
