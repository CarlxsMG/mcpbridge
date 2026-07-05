<script setup lang="ts">
import { ref } from "vue";
import { useI18n } from "vue-i18n";
import { useRouter } from "vue-router";
import { api } from "@/composables/useApi";
import { parseOptionalNumber } from "@/utils/fieldParsing";
import { toErrorMessage } from "@/utils/errors";
import { tk } from "@/i18n";
import type { AlertEventType } from "@/types/api";
import PageHeader from "@/components/ui/PageHeader.vue";
import FormField from "@/components/ui/FormField.vue";
import SelectMenu from "@/components/ui/SelectMenu.vue";
import FormPage from "@/components/ui/FormPage.vue";

const { t } = useI18n({ useScope: "global" });

const EVENT_LABELS: Record<AlertEventType, string> = {
  circuit_breaker_open: t("pages.alerts.event_types.circuit_breaker_open"),
  client_unreachable: t("pages.alerts.event_types.client_unreachable"),
  error_rate: t("pages.alerts.event_types.error_rate"),
  usage_spike: t("pages.alerts.event_types.usage_spike"),
  schema_drift: t("pages.alerts.event_types.schema_drift"),
};
const EVENT_OPTIONS = (Object.keys(EVENT_LABELS) as AlertEventType[]).map((value) => ({
  value,
  label: EVENT_LABELS[value],
}));

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
    nameError.value = t("pages.alerts.errors_create.name_required");
  }
  if (!url.value.trim()) {
    urlError.value = t("pages.alerts.errors_create.url_required");
  }
  if (nameError.value || urlError.value) {
    return;
  }
  let thresholdValue: number | null = null;
  let minCallsValue: number | null = null;
  if (NUMERIC_EVENTS.has(event.value)) {
    const thresholdResult = parseOptionalNumber(threshold.value, t("pages.alerts.errors_create.threshold_invalid"));
    if (thresholdResult.value === null) {
      error.value = t("pages.alerts.errors_create.threshold_invalid");
      return;
    }
    const minCallsResult = parseOptionalNumber(minCalls.value, t("pages.alerts.errors_create.min_calls_invalid"));
    if (minCallsResult.value === null) {
      error.value = t("pages.alerts.errors_create.min_calls_invalid");
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
    error.value = toErrorMessage(err, tk("pages.alerts.errors_create.create_failed"));
  } finally {
    creating.value = false;
  }
}
</script>

<template>
  <section>
    <FormPage max-width="26.25rem">
      <PageHeader :title="t('pages.alerts.new_title')" :back-link="{ to: '/alerts', label: t('nav.alerts.label') }" />
      <p class="hint">
        {{ t("pages.alerts.new_subtitle") }}
      </p>

      <form class="form-card" @submit.prevent="createRule">
        <FormField :label="t('pages.alerts.fields.name')" for="alert-name">
          <input id="alert-name" v-model="name" type="text" placeholder="pager" />
          <p v-if="nameError" class="error">{{ nameError }}</p>
        </FormField>
        <FormField :label="t('pages.alerts.fields.event')" for="alert-event">
          <SelectMenu id="alert-event" v-model="event" :options="EVENT_OPTIONS" />
        </FormField>
        <FormField :label="t('pages.alerts.fields.url')" for="alert-url">
          <input id="alert-url" v-model="url" type="url" placeholder="https://hooks.example.com/x" />
          <p v-if="urlError" class="error">{{ urlError }}</p>
        </FormField>
        <template v-if="NUMERIC_EVENTS.has(event)">
          <FormField
            :label="
              event === 'usage_spike' ? t('pages.alerts.fields.spike_factor') : t('pages.alerts.fields.threshold')
            "
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
          <FormField :label="t('pages.alerts.fields.min_calls')" for="alert-mincalls">
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
          {{ creating ? t("pages.alerts.creating") : t("pages.alerts.create_rule") }}
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
