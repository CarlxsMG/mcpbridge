<script setup lang="ts">
import { ref } from "vue";
import { useRouter } from "vue-router";
import { api } from "@/composables/useApi";
import { parseOptionalNumber } from "@/utils/fieldParsing";
import { toErrorMessage } from "@/utils/errors";
import type { AlertEventType } from "@/types/api";
import PageHeader from "@/components/ui/PageHeader.vue";
import FormField from "@/components/ui/FormField.vue";
import SelectMenu from "@/components/ui/SelectMenu.vue";
import FormPage from "@/components/ui/FormPage.vue";

const EVENT_LABELS: Record<AlertEventType, string> = {
  circuit_breaker_open: "Circuit breaker open",
  client_unreachable: "Client unreachable",
  error_rate: "Error-rate spike",
  usage_spike: "Usage spike (anomaly)",
  schema_drift: "Tool schema drift",
};
const EVENT_OPTIONS = (Object.keys(EVENT_LABELS) as AlertEventType[]).map((value) => ({
  value,
  label: EVENT_LABELS[value],
}));

/** Event types that use the threshold + minCalls numeric inputs. */
const NUMERIC_EVENTS = new Set<AlertEventType>(["error_rate", "usage_spike"]);

const router = useRouter();

const name = ref("");
const event = ref<AlertEventType>("circuit_breaker_open");
const url = ref("");
const threshold = ref("0.5");
const minCalls = ref("10");
const nameError = ref("");
const urlError = ref("");
const error = ref("");
const creating = ref(false);

async function createRule() {
  error.value = "";
  nameError.value = "";
  urlError.value = "";
  if (!name.value.trim()) {
    nameError.value = "Name is required.";
  }
  if (!url.value.trim()) {
    urlError.value = "Webhook URL is required.";
  }
  if (nameError.value || urlError.value) {
    return;
  }
  let thresholdValue: number | null = null;
  let minCallsValue: number | null = null;
  if (NUMERIC_EVENTS.has(event.value)) {
    // threshold/minCalls are required (not optional) in this branch, so a blank
    // value must be rejected too -- parseOptionalNumber treats blank as valid
    // (value: null, error: null), so check .value rather than just .error.
    const thresholdResult = parseOptionalNumber(threshold.value, "Threshold must be a plain number.");
    if (thresholdResult.value === null) {
      error.value = "Threshold must be a plain number.";
      return;
    }
    const minCallsResult = parseOptionalNumber(minCalls.value, "Minimum calls must be a plain number.");
    if (minCallsResult.value === null) {
      error.value = "Minimum calls must be a plain number.";
      return;
    }
    thresholdValue = thresholdResult.value;
    minCallsValue = minCallsResult.value;
  }
  creating.value = true;
  try {
    const body: Record<string, unknown> = {
      name: name.value.trim(),
      eventType: event.value,
      webhookUrl: url.value.trim(),
    };
    if (NUMERIC_EVENTS.has(event.value)) {
      body.threshold = thresholdValue;
      body.minCalls = minCallsValue;
    }
    await api.post("/admin-api/alerts", body);
    await router.push("/alerts");
  } catch (err) {
    error.value = toErrorMessage(err, "Failed to create rule.");
  } finally {
    creating.value = false;
  }
}
</script>

<template>
  <section>
    <FormPage max-width="26.25rem">
      <PageHeader title="New alert rule" :back-link="{ to: '/alerts', label: 'Alerts' }" />
      <p class="hint">
        Rules are evaluated on the leader instance and POST a JSON payload to a webhook when a condition first becomes
        true.
      </p>

      <form class="form-card" @submit.prevent="createRule">
        <FormField label="Name" for="alert-name">
          <input id="alert-name" v-model="name" type="text" placeholder="pager" />
          <p v-if="nameError" class="error">{{ nameError }}</p>
        </FormField>
        <FormField label="Event" for="alert-event">
          <SelectMenu id="alert-event" v-model="event" :options="EVENT_OPTIONS" />
        </FormField>
        <FormField label="Webhook URL" for="alert-url">
          <input id="alert-url" v-model="url" type="url" placeholder="https://hooks.example.com/x" />
          <p v-if="urlError" class="error">{{ urlError }}</p>
        </FormField>
        <template v-if="NUMERIC_EVENTS.has(event)">
          <FormField
            :label="event === 'usage_spike' ? 'Spike factor (× baseline)' : 'Threshold (0–1)'"
            for="alert-threshold"
          >
            <input
              id="alert-threshold"
              v-model="threshold"
              type="text"
              inputmode="decimal"
              :placeholder="event === 'usage_spike' ? '3' : '0.5'"
            />
          </FormField>
          <FormField label="Min calls" for="alert-mincalls">
            <input
              id="alert-mincalls"
              v-model="minCalls"
              type="text"
              inputmode="numeric"
              :placeholder="event === 'usage_spike' ? '20' : '10'"
            />
          </FormField>
        </template>
        <p v-if="error" class="error">{{ error }}</p>
        <button type="submit" class="btn-primary" :disabled="creating">
          {{ creating ? "Creating…" : "Create rule" }}
        </button>
      </form>
    </FormPage>
  </section>
</template>

<style scoped>
.hint {
  color: var(--text-secondary);
  font-size: 0.85rem;
  margin-bottom: 1.25rem;
}
</style>
