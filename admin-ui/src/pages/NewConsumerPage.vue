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
const quota = ref("");
const endUserLimit = ref("");
const nameError = ref("");
const quotaError = ref("");
const endUserLimitError = ref("");
const error = ref("");
const creating = ref(false);

async function createConsumer() {
  nameError.value = "";
  quotaError.value = "";
  endUserLimitError.value = "";
  error.value = "";
  if (!name.value.trim()) {
    nameError.value = t("pages.consumers.new.errors.name_required");
  }
  const quotaResult = parseOptionalNumber(quota.value, t("pages.consumers.new.errors.quota_invalid"));
  quotaError.value = quotaResult.error ?? "";
  const endUserLimitResult = parseOptionalNumber(
    endUserLimit.value,
    t("pages.consumers.new.errors.end_user_limit_invalid"),
  );
  endUserLimitError.value = endUserLimitResult.error ?? "";
  if (nameError.value || quotaError.value || endUserLimitError.value) {
    return;
  }
  creating.value = true;
  try {
    await api.post("/admin-api/consumers", {
      name: name.value.trim(),
      monthlyQuota: quotaResult.value,
      endUserRateLimitPerMin: endUserLimitResult.value,
    });
    await router.push("/consumers");
  } catch (err) {
    error.value = toErrorMessage(err, tk("pages.consumers.new.errors.create_failed"));
  } finally {
    creating.value = false;
  }
}
</script>

<template>
  <section>
    <FormPage max-width="23.75rem">
      <PageHeader
        :title="t('pages.consumers.new.title')"
        :back-link="{ to: '/consumers', label: t('nav.consumers') }"
      />

      <form class="form-card" @submit.prevent="createConsumer">
        <FormField :label="t('pages.consumers.new.fields.name')" for="c-name">
          <input id="c-name" v-model="name" type="text" :placeholder="t('pages.consumers.new.placeholders.name')" />
          <p v-if="nameError" class="error">{{ nameError }}</p>
        </FormField>
        <FormField :label="t('pages.consumers.new.fields.quota')" for="c-quota">
          <input id="c-quota" v-model="quota" type="text" inputmode="numeric" />
          <p v-if="quotaError" class="error">{{ quotaError }}</p>
        </FormField>
        <FormField :label="t('pages.consumers.new.fields.end_user_limit')" for="c-end-user-limit">
          <input id="c-end-user-limit" v-model="endUserLimit" type="text" inputmode="numeric" />
          <p v-if="endUserLimitError" class="error">{{ endUserLimitError }}</p>
        </FormField>
        <p v-if="error" class="error">{{ error }}</p>
        <button type="submit" class="btn-primary" :disabled="creating">
          {{ creating ? t("common.creating") : t("pages.consumers.new.create") }}
        </button>
      </form>
    </FormPage>
  </section>
</template>
