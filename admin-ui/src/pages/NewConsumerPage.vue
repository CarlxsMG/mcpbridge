<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { api } from "@/composables/useApi";
import { useCreateForm } from "@/composables/useCreateForm";
import { numberRangeValidator, parseOptionalNumber } from "@/utils/fieldParsing";
import { CONSUMER_END_USER_RATE_LIMIT, CONSUMER_QUOTA } from "@/utils/fieldConstraints";
import { focusFirstInvalid } from "@/utils/focusFirstInvalid";
import PageHeader from "@/components/ui/PageHeader.vue";
import FormField from "@/components/ui/FormField.vue";
import FormPage from "@/components/ui/FormPage.vue";
import FieldError from "@/components/ui/FieldError.vue";
import UnsavedChangesDialog from "@/components/ui/UnsavedChangesDialog.vue";

const { t } = useI18n({ useScope: "global" });

const name = ref("");
const quota = ref("");
const endUserLimit = ref("");
const nameError = ref("");
const quotaError = ref("");
const endUserLimitError = ref("");

// Range-checked, not just "is it a number": the API takes a positive integer here and
// answers 400 for -5, 2.7 or 0, all of which the old finite-number check let through.
const validateQuota = numberRangeValidator({
  ...CONSUMER_QUOTA,
  message: t("pages.consumers.new.errors.quota_invalid"),
});
const validateEndUserLimit = numberRangeValidator({
  ...CONSUMER_END_USER_RATE_LIMIT,
  message: t("pages.consumers.new.errors.end_user_limit_invalid"),
});

const { creating, error, errorRequestId, run } = useCreateForm({
  submit: () =>
    api.post("/admin-api/consumers", {
      name: name.value.trim(),
      monthlyQuota: parseOptionalNumber(quota.value).value,
      endUserRateLimitPerMin: parseOptionalNumber(endUserLimit.value).value,
    }),
  redirectTo: "/consumers",
  fallbackKey: "pages.consumers.new.errors.create_failed",
});

function createConsumer() {
  error.value = "";
  nameError.value = "";
  quotaError.value = "";
  endUserLimitError.value = "";
  if (!name.value.trim()) {
    nameError.value = t("pages.consumers.new.errors.name_required");
  }
  quotaError.value = validateQuota(quota.value) ?? "";
  endUserLimitError.value = validateEndUserLimit(endUserLimit.value) ?? "";
  if (nameError.value || quotaError.value || endUserLimitError.value) {
    void focusFirstInvalid();
    return;
  }
  return run();
}

const isDirty = computed(
  () => Boolean(name.value.trim()) || Boolean(quota.value.trim()) || Boolean(endUserLimit.value.trim()),
);
</script>

<template>
  <section>
    <FormPage max-width="23.75rem">
      <PageHeader
        :title="t('pages.consumers.new.title')"
        :back-link="{ to: '/consumers', label: t('nav.consumers.label') }"
      />

      <form novalidate class="form-card" @submit.prevent="createConsumer">
        <FormField v-slot="field" :label="t('pages.consumers.new.fields.name')" for="c-name" :error="nameError">
          <input
            id="c-name"
            v-model="name"
            type="text"
            required
            :placeholder="t('pages.consumers.new.placeholders.name')"
            v-bind="field"
          />
        </FormField>
        <FormField v-slot="field" :label="t('pages.consumers.new.fields.quota')" for="c-quota" :error="quotaError">
          <input id="c-quota" v-model="quota" type="text" inputmode="numeric" v-bind="field" />
        </FormField>
        <FormField
          v-slot="field"
          :label="t('pages.consumers.new.fields.end_user_limit')"
          for="c-end-user-limit"
          :error="endUserLimitError"
        >
          <input id="c-end-user-limit" v-model="endUserLimit" type="text" inputmode="numeric" v-bind="field" />
        </FormField>
        <FieldError :message="error" :request-id="errorRequestId" />
        <button type="submit" class="btn-primary" :disabled="creating">
          {{ creating ? t("common.creating") : t("pages.consumers.new.create") }}
        </button>
      </form>
    </FormPage>

    <UnsavedChangesDialog :dirty="isDirty" :bypass="creating" />
  </section>
</template>
