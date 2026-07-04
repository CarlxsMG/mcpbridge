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
const rate = ref("");
const timeout = ref("");
const error = ref("");
const creating = ref(false);

async function createPolicy() {
  error.value = "";
  if (!name.value.trim()) {
    error.value = "Name is required.";
    return;
  }
  const rateResult = parseOptionalNumber(rate.value, "Rate limit must be a plain number (no units), or blank.");
  if (rateResult.error) {
    error.value = rateResult.error;
    return;
  }
  const timeoutResult = parseOptionalNumber(timeout.value, "Timeout must be a plain number (no units), or blank.");
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
    error.value = toErrorMessage(err, "Failed to create policy.");
  } finally {
    creating.value = false;
  }
}
</script>

<template>
  <section>
    <FormPage max-width="26.25rem">
      <PageHeader title="New policy" :back-link="{ to: '/policies', label: 'Guard policies' }" />

      <form class="create-form" @submit.prevent="createPolicy">
        <FormField label="Name" for="p-name">
          <input id="p-name" v-model="name" type="text" placeholder="strict" />
        </FormField>
        <FormField label="Rate limit (calls/min, blank = none)" for="p-rate">
          <input id="p-rate" v-model="rate" type="text" inputmode="numeric" />
        </FormField>
        <FormField label="Timeout (ms, blank = none)" for="p-timeout">
          <input id="p-timeout" v-model="timeout" type="text" inputmode="numeric" />
        </FormField>
        <p v-if="error" class="error">{{ error }}</p>
        <button type="submit" class="btn-primary" :disabled="creating">
          {{ creating ? "Creating…" : "Create policy" }}
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
