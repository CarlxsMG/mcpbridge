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
const quota = ref("");
const endUserLimit = ref("");
const nameError = ref("");
const quotaError = ref("");
const endUserLimitError = ref("");

const { creating, error, run } = useCreateForm({
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
  quotaError.value = parseOptionalNumber(quota.value, t("pages.consumers.new.errors.quota_invalid")).error ?? "";
  endUserLimitError.value =
    parseOptionalNumber(endUserLimit.value, t("pages.consumers.new.errors.end_user_limit_invalid")).error ?? "";
  if (nameError.value || quotaError.value || endUserLimitError.value) {
    return;
  }
  return run();
}

const isDirty = computed(
  () => Boolean(name.value.trim()) || Boolean(quota.value.trim()) || Boolean(endUserLimit.value.trim()),
);
const { pendingLeave, confirmLeave, cancelLeave } = useUnsavedChangesGuard(isDirty, () => creating.value);
</script>

<template>
  <section>
    <FormPage max-width="23.75rem">
      <PageHeader
        :title="t('pages.consumers.new.title')"
        :back-link="{ to: '/consumers', label: t('nav.consumers.label') }"
      />

      <form class="form-card" @submit.prevent="createConsumer">
        <FormField :label="t('pages.consumers.new.fields.name')" for="c-name">
          <input id="c-name" v-model="name" type="text" :placeholder="t('pages.consumers.new.placeholders.name')" />
          <FieldError :message="nameError" />
        </FormField>
        <FormField :label="t('pages.consumers.new.fields.quota')" for="c-quota">
          <input id="c-quota" v-model="quota" type="text" inputmode="numeric" />
          <FieldError :message="quotaError" />
        </FormField>
        <FormField :label="t('pages.consumers.new.fields.end_user_limit')" for="c-end-user-limit">
          <input id="c-end-user-limit" v-model="endUserLimit" type="text" inputmode="numeric" />
          <FieldError :message="endUserLimitError" />
        </FormField>
        <FieldError :message="error" />
        <button type="submit" class="btn-primary" :disabled="creating">
          {{ creating ? t("common.creating") : t("pages.consumers.new.create") }}
        </button>
      </form>
    </FormPage>

    <ConfirmDialog
      :open="pendingLeave"
      :title="t('pages.consumers.new.confirm.leave_title')"
      :message="t('pages.consumers.new.confirm.leave_message')"
      :confirm-label="t('pages.consumers.new.confirm.leave_cta')"
      danger
      @confirm="confirmLeave"
      @cancel="cancelLeave"
    />
  </section>
</template>
