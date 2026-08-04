<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { api } from "@/composables/useApi";
import { useCreateForm } from "@/composables/useCreateForm";
import { numberRangeValidator, parseOptionalNumber } from "@/utils/fieldParsing";
import { WS_IDLE_TIMEOUT_MINUTES, WS_MAX_CONNECTIONS, WS_MAX_MESSAGE_BYTES } from "@/utils/fieldConstraints";
import { focusFirstInvalid } from "@/utils/focusFirstInvalid";
import PageHeader from "@/components/ui/PageHeader.vue";
import FormField from "@/components/ui/FormField.vue";
import FormPage from "@/components/ui/FormPage.vue";
import FieldError from "@/components/ui/FieldError.vue";
import UnsavedChangesDialog from "@/components/ui/UnsavedChangesDialog.vue";

const { t } = useI18n({ useScope: "global" });

const name = ref("");
const backendUrl = ref("");
const maxConnections = ref("");
const maxMessageBytes = ref("");
const idleTimeoutMinutes = ref("");
const nameError = ref("");
const urlError = ref("");
const maxConnectionsError = ref("");
const maxMessageBytesError = ref("");
const idleTimeoutError = ref("");

// The API takes positive integers for all three; a bare finite check let 0, negatives
// and fractions through to a 400.
const validateMaxConnections = numberRangeValidator({
  ...WS_MAX_CONNECTIONS,
  message: t("pages.ws_proxy_targets.errors.max_connections_invalid"),
});
const validateMaxMessageBytes = numberRangeValidator({
  ...WS_MAX_MESSAGE_BYTES,
  message: t("pages.ws_proxy_targets.errors.max_message_bytes_invalid"),
});
const validateIdleTimeout = numberRangeValidator({
  ...WS_IDLE_TIMEOUT_MINUTES,
  message: t("pages.ws_proxy_targets.errors.idle_timeout_invalid"),
});

const { creating, error, errorRequestId, run } = useCreateForm({
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
  // Per-field, and every field checked before returning: the old loop stopped at the
  // first bad value and showed it at the bottom of the form, so a user with two bad
  // fields fixed one, resubmitted, and met the next.
  const required = t("pages.ws_proxy_targets.errors.name_and_url_required");
  nameError.value = name.value.trim() ? "" : required;
  urlError.value = backendUrl.value.trim() ? "" : required;
  maxConnectionsError.value = validateMaxConnections(maxConnections.value) ?? "";
  maxMessageBytesError.value = validateMaxMessageBytes(maxMessageBytes.value) ?? "";
  idleTimeoutError.value = validateIdleTimeout(idleTimeoutMinutes.value) ?? "";
  if (
    nameError.value ||
    urlError.value ||
    maxConnectionsError.value ||
    maxMessageBytesError.value ||
    idleTimeoutError.value
  ) {
    void focusFirstInvalid();
    return;
  }
  return run();
}

const isDirty = computed(
  () =>
    Boolean(name.value.trim()) ||
    Boolean(backendUrl.value.trim()) ||
    Boolean(maxConnections.value.trim()) ||
    Boolean(maxMessageBytes.value.trim()) ||
    Boolean(idleTimeoutMinutes.value.trim()),
);
</script>

<template>
  <section>
    <FormPage max-width="26.25rem">
      <PageHeader
        :title="t('pages.ws_proxy_targets.new.title')"
        :back-link="{ to: '/ws-proxies', label: t('nav.ws-proxies.label') }"
      />

      <form novalidate class="form-card" @submit.prevent="createTarget">
        <FormField v-slot="field" :label="t('pages.ws_proxy_targets.fields.name')" for="wp-name" :error="nameError">
          <input
            id="wp-name"
            v-model="name"
            type="text"
            required
            :placeholder="t('pages.ws_proxy_targets.placeholders.name')"
            v-bind="field"
          />
        </FormField>
        <FormField
          v-slot="field"
          :label="t('pages.ws_proxy_targets.fields.backend_url')"
          for="wp-url"
          :error="urlError"
        >
          <input
            id="wp-url"
            v-model="backendUrl"
            type="text"
            required
            :placeholder="t('pages.ws_proxy_targets.placeholders.backend_url')"
            v-bind="field"
          />
        </FormField>
        <FormField
          v-slot="field"
          :label="t('pages.ws_proxy_targets.fields.max_connections')"
          for="wp-max-conn"
          :error="maxConnectionsError"
        >
          <input id="wp-max-conn" v-model="maxConnections" type="text" inputmode="numeric" v-bind="field" />
        </FormField>
        <FormField
          v-slot="field"
          :label="t('pages.ws_proxy_targets.fields.max_message_bytes')"
          for="wp-max-bytes"
          :error="maxMessageBytesError"
        >
          <input id="wp-max-bytes" v-model="maxMessageBytes" type="text" inputmode="numeric" v-bind="field" />
        </FormField>
        <FormField
          v-slot="field"
          :label="t('pages.ws_proxy_targets.fields.idle_timeout')"
          for="wp-idle"
          :error="idleTimeoutError"
        >
          <input id="wp-idle" v-model="idleTimeoutMinutes" type="text" inputmode="numeric" v-bind="field" />
        </FormField>
        <FieldError :message="error" :request-id="errorRequestId" />
        <button type="submit" class="btn-primary" :disabled="creating">
          {{ creating ? t("common.creating") : t("pages.ws_proxy_targets.new.create") }}
        </button>
      </form>
    </FormPage>

    <UnsavedChangesDialog :dirty="isDirty" :bypass="creating" />
  </section>
</template>
