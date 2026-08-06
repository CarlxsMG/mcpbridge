<script setup lang="ts">
// Dual-mode form: create at /consumers/new, edit at /consumers/:id/edit.
//
// The edit half used to be an inline form rendered above the table on
// ConsumersPage, which meant these three fields and their validators existed
// TWICE — once here, once there — behind two parallel sets of i18n keys
// (`pages.consumers.errors.*` and `pages.consumers.new.errors.*`) holding
// byte-identical text. Folding it in here is what removes that duplication;
// it also retires the scrollIntoView + focus hack the inline form needed,
// since a route change lands focus on <main> on its own.
//
// As with policies there is no GET /admin-api/consumers/:id, so edit mode
// prefills by finding its row in the collection response.
import { computed, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { api } from "@/composables/useApi";
import { useCreateForm } from "@/composables/useCreateForm";
import { numberRangeValidator, parseOptionalNumber } from "@/utils/fieldParsing";
import { CONSUMER_END_USER_RATE_LIMIT, CONSUMER_QUOTA } from "@/utils/fieldConstraints";
import { focusFirstInvalid } from "@/utils/focusFirstInvalid";
import { toErrorMessage } from "@/utils/errors";
import { tk } from "@/i18n";
import type { ConsumerWithUsage } from "@/types/api";
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
const quota = ref("");
const endUserLimit = ref("");
const nameError = ref("");
const quotaError = ref("");
const endUserLimitError = ref("");

const loading = ref(false);
const loadError = ref("");
// See PolicyFormPage: in edit mode `isDirty` compares against what loaded, so
// leaving an untouched edit page doesn't trip the unsaved-changes dialog.
const loaded = ref({ name: "", quota: "", endUserLimit: "" });

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
  submit: () => {
    const payload = {
      name: name.value.trim(),
      monthlyQuota: parseOptionalNumber(quota.value).value,
      endUserRateLimitPerMin: parseOptionalNumber(endUserLimit.value).value,
    };
    return isEdit.value
      ? api.patch(`/admin-api/consumers/${encodeURIComponent(props.id ?? "")}`, payload)
      : api.post("/admin-api/consumers", payload);
  },
  redirectTo: "/consumers",
  // Mode-specific: a failed PATCH saying "could not create" is a wrong answer.
  // Safe to read `isEdit` once here — the route param can't change without
  // remounting the component.
  fallbackKey: isEdit.value ? "pages.consumers.edit.save_failed" : "pages.consumers.new.errors.create_failed",
});

onMounted(async () => {
  if (!isEdit.value) return;
  loading.value = true;
  try {
    const res = await api.get<{ items: ConsumerWithUsage[] }>("/admin-api/consumers");
    const consumer = res.items.find((x) => String(x.id) === props.id);
    if (!consumer) {
      loadError.value = t("pages.consumers.edit.not_found");
      return;
    }
    name.value = consumer.name;
    quota.value = consumer.monthlyQuota !== null ? String(consumer.monthlyQuota) : "";
    endUserLimit.value = consumer.endUserRateLimitPerMin !== null ? String(consumer.endUserRateLimitPerMin) : "";
    loaded.value = { name: name.value, quota: quota.value, endUserLimit: endUserLimit.value };
  } catch (err) {
    loadError.value = toErrorMessage(err, tk("pages.consumers.edit.load_failed"));
  } finally {
    loading.value = false;
  }
});

function submitConsumer() {
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

const isDirty = computed(() => {
  if (isEdit.value) {
    return (
      name.value !== loaded.value.name ||
      quota.value !== loaded.value.quota ||
      endUserLimit.value !== loaded.value.endUserLimit
    );
  }
  return Boolean(name.value.trim()) || Boolean(quota.value.trim()) || Boolean(endUserLimit.value.trim());
});
</script>

<template>
  <section>
    <FormPage max-width="23.75rem">
      <PageHeader
        :title="isEdit ? t('pages.consumers.edit.title') : t('pages.consumers.new.title')"
        :back-link="{ to: '/consumers', label: t('nav.consumers.label') }"
      />

      <SignalLoader v-if="loading" />
      <FieldError v-else-if="loadError" :message="loadError" />

      <form v-else novalidate class="form-card" @submit.prevent="submitConsumer">
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
          {{
            creating
              ? isEdit
                ? t("common.saving")
                : t("common.creating")
              : isEdit
                ? t("common.save_changes")
                : t("pages.consumers.new.create")
          }}
        </button>
      </form>
    </FormPage>

    <UnsavedChangesDialog :dirty="isDirty" :bypass="creating" />
  </section>
</template>
