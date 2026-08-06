<script setup lang="ts">
// Dual-mode form: create at /ws-proxies/new, edit at /ws-proxies/:id/edit
// (the ":id" is the target's NAME — these are keyed by name, not a numeric id).
// See PolicyFormPage.vue for why create and edit share one component.
//
// Two things the inline edit form this replaces got wrong, fixed here:
//   - It rendered the name as an editable input and validated it, but never
//     sent it. The API keys targets by name (PATCH /ws-proxy-targets/:name),
//     so renaming isn't possible — the field is readonly in edit mode now,
//     with a hint saying why, instead of silently discarding the change.
//   - Its errors all landed in one message at the bottom of the form. Since
//     the create half already validated per-field, the two halves disagreed
//     about where a validation message belongs; now there is only one answer.
import { computed, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { api } from "@/composables/useApi";
import { useCreateForm } from "@/composables/useCreateForm";
import { numberRangeValidator, parseOptionalNumber } from "@/utils/fieldParsing";
import { WS_IDLE_TIMEOUT_MINUTES, WS_MAX_CONNECTIONS, WS_MAX_MESSAGE_BYTES } from "@/utils/fieldConstraints";
import { focusFirstInvalid } from "@/utils/focusFirstInvalid";
import { toErrorMessage } from "@/utils/errors";
import { tk } from "@/i18n";
import type { WsProxyTarget } from "@/types/api";
import PageHeader from "@/components/ui/PageHeader.vue";
import FormField from "@/components/ui/FormField.vue";
import FormPage from "@/components/ui/FormPage.vue";
import FieldError from "@/components/ui/FieldError.vue";
import SignalLoader from "@/components/ui/SignalLoader.vue";
import UnsavedChangesDialog from "@/components/ui/UnsavedChangesDialog.vue";

const props = defineProps<{ id?: string }>();

const { t } = useI18n({ useScope: "global" });

const isEdit = computed(() => props.id !== undefined);

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

const loading = ref(false);
const loadError = ref("");
const loaded = ref("");

function snapshot(): string {
  return JSON.stringify([
    name.value,
    backendUrl.value,
    maxConnections.value,
    maxMessageBytes.value,
    idleTimeoutMinutes.value,
  ]);
}

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
    const body: Record<string, unknown> = { backendWsUrl: backendUrl.value.trim() };
    const maxConnectionsValue = parseOptionalNumber(maxConnections.value).value;
    const maxMessageBytesValue = parseOptionalNumber(maxMessageBytes.value).value;
    const idleTimeoutMinutesValue = parseOptionalNumber(idleTimeoutMinutes.value).value;
    if (maxConnectionsValue !== null) body.maxConnections = maxConnectionsValue;
    if (maxMessageBytesValue !== null) body.maxMessageBytes = maxMessageBytesValue;
    if (idleTimeoutMinutesValue !== null) body.idleTimeoutMs = idleTimeoutMinutesValue * 60_000;
    if (isEdit.value) {
      return api.patch(`/admin-api/ws-proxy-targets/${encodeURIComponent(props.id ?? "")}`, body);
    }
    // Only the create call carries `name` — PATCH takes it from the path.
    body.name = name.value.trim();
    return api.post("/admin-api/ws-proxy-targets", body);
  },
  redirectTo: "/ws-proxies",
  // Mode-specific: a failed PATCH saying "could not create" is a wrong answer.
  // Safe to read `isEdit` once here — the route param can't change without
  // remounting the component.
  fallbackKey: isEdit.value
    ? "pages.ws_proxy_targets.errors.save_failed"
    : "pages.ws_proxy_targets.errors.create_failed",
});

onMounted(async () => {
  if (!isEdit.value) return;
  loading.value = true;
  try {
    const res = await api.get<{ items: WsProxyTarget[] }>("/admin-api/ws-proxy-targets");
    const target = res.items.find((x) => x.name === props.id);
    if (!target) {
      loadError.value = t("pages.ws_proxy_targets.edit.not_found");
      return;
    }
    name.value = target.name;
    backendUrl.value = target.backendWsUrl;
    maxConnections.value = String(target.maxConnections);
    maxMessageBytes.value = String(target.maxMessageBytes);
    idleTimeoutMinutes.value = String(Math.round(target.idleTimeoutMs / 60_000));
    loaded.value = snapshot();
  } catch (err) {
    loadError.value = toErrorMessage(err, tk("pages.ws_proxy_targets.edit.load_failed"));
  } finally {
    loading.value = false;
  }
});

function submitTarget() {
  // Per-field, and every field checked before returning: the old loop stopped at the
  // first bad value and showed it at the bottom of the form, so a user with two bad
  // fields fixed one, resubmitted, and met the next.
  const required = t("pages.ws_proxy_targets.errors.name_and_url_required");
  nameError.value = isEdit.value || name.value.trim() ? "" : required;
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

const isDirty = computed(() => {
  if (isEdit.value) return loaded.value !== "" && snapshot() !== loaded.value;
  return (
    Boolean(name.value.trim()) ||
    Boolean(backendUrl.value.trim()) ||
    Boolean(maxConnections.value.trim()) ||
    Boolean(maxMessageBytes.value.trim()) ||
    Boolean(idleTimeoutMinutes.value.trim())
  );
});
</script>

<template>
  <section>
    <FormPage max-width="26.25rem">
      <PageHeader
        :title="isEdit ? t('pages.ws_proxy_targets.edit.title') : t('pages.ws_proxy_targets.new.title')"
        :back-link="{ to: '/ws-proxies', label: t('nav.ws-proxies.label') }"
      />

      <SignalLoader v-if="loading" />
      <FieldError v-else-if="loadError" :message="loadError" />

      <form v-else novalidate class="form-card" @submit.prevent="submitTarget">
        <FormField v-slot="field" :label="t('pages.ws_proxy_targets.fields.name')" for="wp-name" :error="nameError">
          <!-- readonly, not disabled, in edit mode: a disabled input is skipped
               by screen readers and not focusable, so the user gets no way to
               read the value they are editing against. -->
          <input
            id="wp-name"
            v-model="name"
            type="text"
            :required="!isEdit"
            :readonly="isEdit"
            :placeholder="t('pages.ws_proxy_targets.placeholders.name')"
            v-bind="field"
          />
          <p v-if="isEdit" class="hint">{{ t("pages.ws_proxy_targets.edit.name_fixed") }}</p>
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
          {{
            creating
              ? isEdit
                ? t("common.saving")
                : t("common.creating")
              : isEdit
                ? t("common.save_changes")
                : t("pages.ws_proxy_targets.new.create")
          }}
        </button>
      </form>
    </FormPage>

    <UnsavedChangesDialog :dirty="isDirty" :bypass="creating" />
  </section>
</template>
