<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { useRouter } from "vue-router";
import { api } from "@/composables/useApi";
import { toErrorMessage } from "@/utils/errors";
import { describeCron } from "@/utils/cron";
import { tk } from "@/i18n";
import PageHeader from "@/components/ui/PageHeader.vue";
import FormField from "@/components/ui/FormField.vue";
import FormPage from "@/components/ui/FormPage.vue";
import SelectMenu from "@/components/ui/SelectMenu.vue";

const { t } = useI18n({ useScope: "global" });

type Frequency = "daily" | "weekly" | "hourly" | "custom";

const TARGET_TYPE_OPTIONS: { value: "client" | "tool"; label: string }[] = [
  { value: "client", label: t("pages.schedules.new.target_types.client") },
  { value: "tool", label: t("pages.schedules.new.target_types.tool") },
];
const ACTION_OPTIONS: { value: "enable" | "disable"; label: string }[] = [
  { value: "disable", label: t("pages.schedules.new.actions.disable") },
  { value: "enable", label: t("pages.schedules.new.actions.enable") },
];
const FREQUENCY_OPTIONS: { value: Frequency; label: string }[] = [
  { value: "daily", label: t("pages.schedules.new.frequencies.daily") },
  { value: "weekly", label: t("pages.schedules.new.frequencies.weekly") },
  { value: "hourly", label: t("pages.schedules.new.frequencies.hourly") },
  { value: "custom", label: t("pages.schedules.new.frequencies.custom") },
];
const MINUTE_OPTIONS = [
  { value: 0, label: ":00" },
  { value: 15, label: ":15" },
  { value: 30, label: ":30" },
  { value: 45, label: ":45" },
];
const WEEKDAY_OPTIONS = [
  { value: 0, label: t("pages.schedules.new.weekdays.sun") },
  { value: 1, label: t("pages.schedules.new.weekdays.mon") },
  { value: 2, label: t("pages.schedules.new.weekdays.tue") },
  { value: 3, label: t("pages.schedules.new.weekdays.wed") },
  { value: 4, label: t("pages.schedules.new.weekdays.thu") },
  { value: 5, label: t("pages.schedules.new.weekdays.fri") },
  { value: 6, label: t("pages.schedules.new.weekdays.sat") },
];

const router = useRouter();

const targetType = ref<"client" | "tool">("client");
const clientName = ref("");
const toolName = ref("");
const action = ref<"enable" | "disable">("disable");

const frequency = ref<Frequency>("daily");
const timeOfDay = ref("03:00");
const weekdays = ref<number[]>([1]);
const minuteOfHour = ref(0);
const customCron = ref("0 3 * * *");
const weekdaysError = ref("");

function toggleWeekday(day: number) {
  const idx = weekdays.value.indexOf(day);
  if (idx === -1) weekdays.value.push(day);
  else weekdays.value.splice(idx, 1);
  weekdaysError.value = "";
}

const computedCron = computed(() => {
  if (frequency.value === "custom") return customCron.value.trim();
  const [hh, mm] = timeOfDay.value.split(":").map((v) => Number(v));
  const hour = Number.isFinite(hh) ? hh : 0;
  const minute = Number.isFinite(mm) ? mm : 0;
  if (frequency.value === "daily") {
    return `${minute} ${hour} * * *`;
  }
  if (frequency.value === "weekly") {
    const days = [...weekdays.value].sort((a, b) => a - b);
    return `${minute} ${hour} * * ${days.length ? days.join(",") : "*"}`;
  }
  return `${minuteOfHour.value} * * * *`;
});
const cronPreview = computed(() => describeCron(computedCron.value));

const error = ref("");
const creating = ref(false);

async function createSchedule() {
  error.value = "";
  weekdaysError.value = "";
  if (!clientName.value.trim()) {
    error.value = t("pages.schedules.new.errors.client_required");
    return;
  }
  if (frequency.value === "weekly" && weekdays.value.length === 0) {
    weekdaysError.value = t("pages.schedules.new.errors.weekdays_required");
    return;
  }
  if (frequency.value === "custom" && !customCron.value.trim()) {
    error.value = t("pages.schedules.new.errors.cron_required");
    return;
  }
  creating.value = true;
  try {
    await api.post("/admin-api/schedules", {
      targetType: targetType.value,
      clientName: clientName.value.trim(),
      toolName: targetType.value === "tool" ? toolName.value.trim() : undefined,
      action: action.value,
      cron: computedCron.value,
    });
    await router.push("/schedules");
  } catch (err) {
    error.value = toErrorMessage(err, tk("pages.schedules.new.errors.create_failed"));
  } finally {
    creating.value = false;
  }
}
</script>

<template>
  <section>
    <FormPage max-width="28.75rem">
      <PageHeader :title="t('pages.schedules.new.title')" :back-link="{ to: '/schedules', label: t('nav.schedules') }" />
      <p class="hint">
        {{ t('pages.schedules.new.subtitle') }}
      </p>

      <form class="form-card" @submit.prevent="createSchedule">
        <FormField :label="t('pages.schedules.new.fields.type')" for="sched-type">
          <SelectMenu id="sched-type" v-model="targetType" :options="TARGET_TYPE_OPTIONS" />
        </FormField>
        <FormField :label="t('pages.schedules.new.fields.client')" for="sched-client">
          <input id="sched-client" v-model="clientName" type="text" :placeholder="t('pages.schedules.new.placeholders.client')" />
        </FormField>
        <FormField v-if="targetType === 'tool'" :label="t('pages.schedules.new.fields.tool')" for="sched-tool">
          <input id="sched-tool" v-model="toolName" type="text" :placeholder="t('pages.schedules.new.placeholders.tool')" />
        </FormField>
        <FormField :label="t('pages.schedules.new.fields.action')" for="sched-action">
          <SelectMenu id="sched-action" v-model="action" :options="ACTION_OPTIONS" />
        </FormField>

        <FormField :label="t('pages.schedules.new.fields.frequency')" for="sched-frequency">
          <SelectMenu id="sched-frequency" v-model="frequency" :options="FREQUENCY_OPTIONS" />
        </FormField>

        <FormField v-if="frequency === 'daily' || frequency === 'weekly'" :label="t('pages.schedules.new.fields.time')" for="sched-time">
          <input id="sched-time" v-model="timeOfDay" type="time" />
        </FormField>

        <FormField v-if="frequency === 'weekly'" :label="t('pages.schedules.new.fields.days')" for="sched-weekdays">
          <div id="sched-weekdays" class="weekday-picker" role="group" :aria-label="t('pages.schedules.new.days_aria')">
            <button
              v-for="day in WEEKDAY_OPTIONS"
              :key="day.value"
              type="button"
              class="weekday-chip"
              :class="{ 'is-selected': weekdays.includes(day.value) }"
              :aria-pressed="weekdays.includes(day.value)"
              @click="toggleWeekday(day.value)"
            >
              {{ day.label }}
            </button>
          </div>
          <p v-if="weekdaysError" class="error">{{ weekdaysError }}</p>
        </FormField>

        <FormField v-if="frequency === 'hourly'" :label="t('pages.schedules.new.fields.minute')" for="sched-minute">
          <SelectMenu id="sched-minute" v-model="minuteOfHour" :options="MINUTE_OPTIONS" />
        </FormField>

        <FormField v-if="frequency === 'custom'" :label="t('pages.schedules.new.fields.cron')" for="sched-cron">
          <input id="sched-cron" v-model="customCron" type="text" placeholder="0 3 * * *" class="cron" />
          <p class="hint">{{ t('pages.schedules.new.cron_hint') }} <code>min hour day-of-month month day-of-week</code>.</p>
        </FormField>

        <p class="cron-preview">
          {{ t('pages.schedules.new.runs') }} <strong>{{ cronPreview }}</strong>
          <span v-if="frequency !== 'custom'" class="cron-raw">({{ computedCron }})</span>
        </p>

        <p v-if="error" class="error">{{ error }}</p>
        <button class="btn-primary" type="submit" :disabled="creating">
          {{ creating ? t('common.creating') : t('pages.schedules.new.create') }}
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
:deep(.field .cron) {
  font-family: var(--font-mono);
}
:deep(.field .hint) {
  margin: 0.35rem 0 0;
  font-size: 0.8rem;
}
.weekday-picker {
  display: flex;
  gap: 0.4rem;
  flex-wrap: wrap;
}
.weekday-chip {
  border: 1px solid var(--border-strong);
  background: var(--surface);
  color: var(--text-secondary);
  border-radius: var(--radius-pill);
  padding: 0.3rem 0.7rem;
  font-size: 0.8rem;
  font-weight: 600;
  cursor: pointer;
}
.weekday-chip:hover {
  background: var(--surface-sunken);
}
.weekday-chip.is-selected {
  border-color: var(--signal);
  background: var(--signal-soft);
  color: var(--signal-strong);
}
.cron-preview {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 0.4rem;
  font-size: 0.85rem;
  color: var(--text-secondary);
  background: var(--surface-sunken);
  border-radius: var(--radius-sm);
  padding: 0.6rem 0.75rem;
  margin: 0;
}
.cron-preview strong {
  color: var(--text-primary);
}
.cron-raw {
  font-family: var(--font-mono);
  font-size: 0.78rem;
  color: var(--text-muted);
}
</style>