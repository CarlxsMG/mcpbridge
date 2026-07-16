<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { api } from "@/composables/useApi";
import { useCreateForm } from "@/composables/useCreateForm";
import { useUnsavedChangesGuard } from "@/composables/useUnsavedChangesGuard";
import { parseOptionalNumber } from "@/utils/fieldParsing";
import type { AlertEventType } from "@/types/api";
import PageHeader from "@/components/ui/PageHeader.vue";
import FormField from "@/components/ui/FormField.vue";
import SelectMenu from "@/components/ui/SelectMenu.vue";
import FormPage from "@/components/ui/FormPage.vue";
import FieldError from "@/components/ui/FieldError.vue";
import ConfirmDialog from "@/components/ui/ConfirmDialog.vue";

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
// Per-event-type sane defaults for threshold/minCalls — error_rate's
// threshold is a 0..1 ratio, usage_spike's is a ×baseline spike factor, so a
// value carried over verbatim from the other event type is silently
// scale-mismatched (see NewAlertPage finding).
const NUMERIC_DEFAULTS: Record<"error_rate" | "usage_spike", { threshold: string; minCalls: string }> = {
  error_rate: { threshold: "0.5", minCalls: "10" },
  usage_spike: { threshold: "3", minCalls: "20" },
};

const name = ref("");
const event = ref<AlertEventType>("circuit_breaker_open");
const url = ref("");
const threshold = ref(NUMERIC_DEFAULTS.error_rate.threshold);
const minCalls = ref(NUMERIC_DEFAULTS.error_rate.minCalls);
const nameError = ref("");
const urlError = ref("");

// Tracks the values we last set programmatically so a later event-type
// switch only resets threshold/minCalls when the user hasn't customized them
// since the previous switch — manual edits are left alone.
let lastAutoThreshold = threshold.value;
let lastAutoMinCalls = minCalls.value;

watch(event, (next) => {
  if (next !== "error_rate" && next !== "usage_spike") return;
  const defaults = NUMERIC_DEFAULTS[next];
  if (threshold.value === lastAutoThreshold) threshold.value = defaults.threshold;
  if (minCalls.value === lastAutoMinCalls) minCalls.value = defaults.minCalls;
  lastAutoThreshold = threshold.value;
  lastAutoMinCalls = minCalls.value;
});

const { creating, error, run } = useCreateForm({
  submit: () => {
    const body: Record<string, unknown> = {
      name: name.value.trim(),
      eventType: event.value,
      webhookUrl: url.value.trim(),
    };
    if (NUMERIC_EVENTS.has(event.value)) {
      body.threshold = parseOptionalNumber(threshold.value).value;
      body.minCalls = parseOptionalNumber(minCalls.value).value;
    }
    return api.post("/admin-api/alerts", body);
  },
  redirectTo: "/alerts",
  fallbackKey: "pages.alerts.errors_create.create_failed",
});

function validateThresholds(): string | null {
  if (NUMERIC_EVENTS.has(event.value)) {
    const thresholdResult = parseOptionalNumber(threshold.value, t("pages.alerts.errors_create.threshold_invalid"));
    if (thresholdResult.value === null) {
      return t("pages.alerts.errors_create.threshold_invalid");
    }
    const minCallsResult = parseOptionalNumber(minCalls.value, t("pages.alerts.errors_create.min_calls_invalid"));
    if (minCallsResult.value === null) {
      return t("pages.alerts.errors_create.min_calls_invalid");
    }
  }
  return null;
}

function createRule() {
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
  return run(validateThresholds);
}

const isDirty = computed(
  () =>
    Boolean(name.value.trim()) ||
    Boolean(url.value.trim()) ||
    event.value !== "circuit_breaker_open" ||
    threshold.value !== "0.5" ||
    minCalls.value !== "10",
);
const { pendingLeave, confirmLeave, cancelLeave } = useUnsavedChangesGuard(isDirty, () => creating.value);
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
          <FieldError :message="nameError" />
        </FormField>
        <FormField :label="t('pages.alerts.fields.event')" for="alert-event">
          <SelectMenu id="alert-event" v-model="event" :options="EVENT_OPTIONS" />
        </FormField>
        <FormField :label="t('pages.alerts.fields.url')" for="alert-url">
          <input id="alert-url" v-model="url" type="url" placeholder="https://hooks.example.com/x" />
          <FieldError :message="urlError" />
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
        <FieldError :message="error" />
        <button type="submit" class="btn-primary" :disabled="creating">
          {{ creating ? t("pages.alerts.creating") : t("pages.alerts.create_rule") }}
        </button>
      </form>
    </FormPage>

    <ConfirmDialog
      :open="pendingLeave"
      :title="t('pages.alerts.confirm.leave_title')"
      :message="t('pages.alerts.confirm.leave_message')"
      :confirm-label="t('pages.alerts.confirm.leave_cta')"
      danger
      @confirm="confirmLeave"
      @cancel="cancelLeave"
    />
  </section>
</template>

<style scoped>
.hint {
  color: var(--text-secondary);
  font-size: 0.85rem;
  margin-bottom: 1.25rem;
}
</style>
