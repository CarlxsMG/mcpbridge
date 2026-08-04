<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { api } from "@/composables/useApi";
import { useCreateForm } from "@/composables/useCreateForm";
import { numberRangeValidator, parseOptionalNumber } from "@/utils/fieldParsing";
import { POLICY_RATE_LIMIT, POLICY_TIMEOUT_MS } from "@/utils/fieldConstraints";
import { focusFirstInvalid } from "@/utils/focusFirstInvalid";
import PageHeader from "@/components/ui/PageHeader.vue";
import FormField from "@/components/ui/FormField.vue";
import FormPage from "@/components/ui/FormPage.vue";
import FieldError from "@/components/ui/FieldError.vue";
import UnsavedChangesDialog from "@/components/ui/UnsavedChangesDialog.vue";

const { t } = useI18n({ useScope: "global" });

const name = ref("");
const rate = ref("");
const timeout = ref("");
const nameError = ref("");
const rateError = ref("");
const timeoutError = ref("");

// Range-checked to the API's own limits. A bare finite-number check let a negative
// rate and a timeout above the 600000 ms ceiling reach the server, which answers 400.
const validateRate = numberRangeValidator({
  ...POLICY_RATE_LIMIT,
  message: t("pages.policies.new.errors.rate_invalid"),
});
const validateTimeout = numberRangeValidator({
  ...POLICY_TIMEOUT_MS,
  message: t("pages.policies.new.errors.timeout_invalid"),
});

const { creating, error, errorRequestId, run } = useCreateForm({
  submit: () =>
    api.post("/admin-api/policies", {
      name: name.value.trim(),
      rateLimitPerMin: parseOptionalNumber(rate.value).value,
      timeoutMs: parseOptionalNumber(timeout.value).value,
    }),
  redirectTo: "/policies",
  fallbackKey: "pages.policies.new.errors.create_failed",
});

function createPolicy() {
  // Per-field rather than one message at the bottom: each of these names the field it
  // is about, so it belongs next to that field and can be linked to it.
  nameError.value = name.value.trim() ? "" : t("pages.policies.new.errors.name_required");
  rateError.value = validateRate(rate.value) ?? "";
  timeoutError.value = validateTimeout(timeout.value) ?? "";
  if (nameError.value || rateError.value || timeoutError.value) {
    void focusFirstInvalid();
    return;
  }
  return run();
}

const isDirty = computed(
  () => Boolean(name.value.trim()) || Boolean(rate.value.trim()) || Boolean(timeout.value.trim()),
);
</script>

<template>
  <section>
    <FormPage max-width="26.25rem">
      <PageHeader
        :title="t('pages.policies.new.title')"
        :back-link="{ to: '/policies', label: t('nav.policies.label') }"
      />

      <form novalidate class="form-card" @submit.prevent="createPolicy">
        <FormField v-slot="field" :label="t('pages.policies.new.fields.name')" for="p-name" :error="nameError">
          <input
            id="p-name"
            v-model="name"
            type="text"
            required
            :placeholder="t('pages.policies.new.placeholders.name')"
            v-bind="field"
          />
        </FormField>
        <FormField v-slot="field" :label="t('pages.policies.new.fields.rate')" for="p-rate" :error="rateError">
          <input id="p-rate" v-model="rate" type="text" inputmode="numeric" v-bind="field" />
        </FormField>
        <FormField v-slot="field" :label="t('pages.policies.new.fields.timeout')" for="p-timeout" :error="timeoutError">
          <input id="p-timeout" v-model="timeout" type="text" inputmode="numeric" v-bind="field" />
        </FormField>
        <FieldError :message="error" :request-id="errorRequestId" />
        <button type="submit" class="btn-primary" :disabled="creating">
          {{ creating ? t("common.creating") : t("pages.policies.new.create") }}
        </button>
      </form>
    </FormPage>

    <UnsavedChangesDialog :dirty="isDirty" :bypass="creating" />
  </section>
</template>
