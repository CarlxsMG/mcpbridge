<script setup lang="ts">
import { ref } from "vue";
import { useRouter } from "vue-router";
import { api } from "@/composables/useApi";
import { parseOptionalNumber } from "@/utils/fieldParsing";
import { toErrorMessage } from "@/utils/errors";
import PageHeader from "@/components/ui/PageHeader.vue";
import FormField from "@/components/ui/FormField.vue";
import FormPage from "@/components/ui/FormPage.vue";

const router = useRouter();

const name = ref("");
const quota = ref("");
const endUserLimit = ref("");
const nameError = ref("");
const quotaError = ref("");
const endUserLimitError = ref("");
const creating = ref(false);

async function createConsumer() {
  nameError.value = "";
  quotaError.value = "";
  endUserLimitError.value = "";
  if (!name.value.trim()) {
    nameError.value = "Name is required.";
  }
  const quotaResult = parseOptionalNumber(quota.value, "Monthly quota must be a plain number, or blank.");
  quotaError.value = quotaResult.error ?? "";
  const endUserLimitResult = parseOptionalNumber(
    endUserLimit.value,
    "Per-end-user rate limit must be a plain number, or blank.",
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
    nameError.value = toErrorMessage(err, "Failed to create consumer.");
  } finally {
    creating.value = false;
  }
}
</script>

<template>
  <section>
    <FormPage max-width="23.75rem">
      <PageHeader title="New consumer" :back-link="{ to: '/consumers', label: 'Consumers' }" />

      <form class="create-form" @submit.prevent="createConsumer">
        <FormField label="Name" for="c-name">
          <input id="c-name" v-model="name" type="text" placeholder="mobile-app" />
          <p v-if="nameError" class="error">{{ nameError }}</p>
        </FormField>
        <FormField label="Monthly quota (blank = unlimited)" for="c-quota">
          <input id="c-quota" v-model="quota" type="text" inputmode="numeric" />
          <p v-if="quotaError" class="error">{{ quotaError }}</p>
        </FormField>
        <FormField label="Per-end-user rate limit (calls/min, blank = disabled)" for="c-end-user-limit">
          <input id="c-end-user-limit" v-model="endUserLimit" type="text" inputmode="numeric" />
          <p v-if="endUserLimitError" class="error">{{ endUserLimitError }}</p>
        </FormField>
        <button type="submit" class="btn-primary" :disabled="creating">
          {{ creating ? "Creating…" : "Create consumer" }}
        </button>
      </form>
    </FormPage>
  </section>
</template>

<style scoped>
.create-form {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-xs);
  padding: 1.25rem;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}
</style>
