<script setup lang="ts">
import { ref } from "vue";
import { useI18n } from "vue-i18n";
import { api } from "@/composables/useApi";
import { useCreateForm } from "@/composables/useCreateForm";
import { parseOptionalNumber } from "@/utils/fieldParsing";
import PageHeader from "@/components/ui/PageHeader.vue";
import FormField from "@/components/ui/FormField.vue";
import FormPage from "@/components/ui/FormPage.vue";
import FieldError from "@/components/ui/FieldError.vue";

const { t } = useI18n({ useScope: "global" });

const name = ref("");
const rate = ref("");
const timeout = ref("");

const { creating, error, run } = useCreateForm({
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
  return run(() => {
    if (!name.value.trim()) return t("pages.policies.new.errors.name_required");
    const rateResult = parseOptionalNumber(rate.value, t("pages.policies.new.errors.rate_invalid"));
    if (rateResult.error) return rateResult.error;
    const timeoutResult = parseOptionalNumber(timeout.value, t("pages.policies.new.errors.timeout_invalid"));
    if (timeoutResult.error) return timeoutResult.error;
    return null;
  });
}
</script>

<template>
  <section>
    <FormPage max-width="26.25rem">
      <PageHeader
        :title="t('pages.policies.new.title')"
        :back-link="{ to: '/policies', label: t('nav.policies.label') }"
      />

      <form class="form-card" @submit.prevent="createPolicy">
        <FormField :label="t('pages.policies.new.fields.name')" for="p-name">
          <input id="p-name" v-model="name" type="text" :placeholder="t('pages.policies.new.placeholders.name')" />
        </FormField>
        <FormField :label="t('pages.policies.new.fields.rate')" for="p-rate">
          <input id="p-rate" v-model="rate" type="text" inputmode="numeric" />
        </FormField>
        <FormField :label="t('pages.policies.new.fields.timeout')" for="p-timeout">
          <input id="p-timeout" v-model="timeout" type="text" inputmode="numeric" />
        </FormField>
        <FieldError :message="error" />
        <button type="submit" class="btn-primary" :disabled="creating">
          {{ creating ? t("common.creating") : t("pages.policies.new.create") }}
        </button>
      </form>
    </FormPage>
  </section>
</template>
