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
const rate = ref("");
const timeout = ref("");
const error = ref("");
const creating = ref(false);

async function createPolicy() {
  error.value = "";
  if (!name.value.trim()) {
    error.value = t("pages.policies.new.errors.name_required");
    return;
  }
  const rateResult = parseOptionalNumber(rate.value, t("pages.policies.new.errors.rate_invalid"));
  if (rateResult.error) {
    error.value = rateResult.error;
    return;
  }
  const timeoutResult = parseOptionalNumber(timeout.value, t("pages.policies.new.errors.timeout_invalid"));
  if (timeoutResult.error) {
    error.value = timeoutResult.error;
    return;
  }
  creating.value = true;
  try {
    await api.post("/admin-api/policies", {
      name: name.value.trim(),
      rateLimitPerMin: rateResult.value,
      timeoutMs: timeoutResult.value,
    });
    await router.push("/policies");
  } catch (err) {
    error.value = toErrorMessage(err, tk("pages.policies.new.errors.create_failed"));
  } finally {
    creating.value = false;
  }
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
        <p v-if="error" class="error">{{ error }}</p>
        <button type="submit" class="btn-primary" :disabled="creating">
          {{ creating ? t("common.creating") : t("pages.policies.new.create") }}
        </button>
      </form>
    </FormPage>
  </section>
</template>
