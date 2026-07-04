<script setup lang="ts">
import { computed, ref } from "vue";
import { useRouter } from "vue-router";
import { api } from "@/composables/useApi";
import { toErrorMessage } from "@/utils/errors";
import { describeCron, WEEKDAY_OPTIONS } from "@/utils/cron";
import PageHeader from "@/components/ui/PageHeader.vue";
import FormField from "@/components/ui/FormField.vue";
import FormPage from "@/components/ui/FormPage.vue";
import SelectMenu from "@/components/ui/SelectMenu.vue";

type Frequency = "daily" | "weekly" | "hourly" | "custom";

const TARGET_TYPE_OPTIONS: { value: "client" | "tool"; label: string }[] = [
  { value: "client", label: "Client" },
  { value: "tool", label: "Tool" },
];
const ACTION_OPTIONS: { value: "enable" | "disable"; label: string }[] = [
  { value: "disable", label: "disable" },
  { value: "enable", label: "enable" },
];
const FREQUENCY_OPTIONS: { value: Frequency; label: string }[] = [
  { value: "daily", label: "Every day" },
  { value: "weekly", label: "Every week, on specific days" },
  { value: "hourly", label: "Every hour" },
  { value: "custom", label: "Custom (cron expression)" },
];
const MINUTE_OPTIONS = [
  { value: 0, label: ":00" },
  { value: 15, label: ":15" },
  { value: 30, label: ":30" },
  { value: 45, label: ":45" },
];

const router = useRouter();

const targetType = ref<"client" | "tool">("client");
const clientName = ref("");
const toolName = ref("");
const action = ref<"enable" | "disable">("disable");

// "When" — a plain-language recipe by default (no cron knowledge required);
// "Custom" is the escape hatch for anyone who already knows cron syntax.
const frequency = ref<Frequency>("daily");
const timeOfDay = ref("03:00"); // <input type="time"> value, "HH:MM"
const weekdays = ref<number[]>([1]); // Monday, so "weekly" never starts out empty
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
  // hourly
  return `${minuteOfHour.value} * * * *`;
});
const cronPreview = computed(() => describeCron(computedCron.value));

const error = ref("");
const creating = ref(false);

async function createSchedule() {
  error.value = "";
  weekdaysError.value = "";
  if (!clientName.value.trim()) {
    error.value = "Client is required.";
    return;
  }
  if (frequency.value === "weekly" && weekdays.value.length === 0) {
    weekdaysError.value = "Select at least one day.";
    return;
  }
  if (frequency.value === "custom" && !customCron.value.trim()) {
    error.value = "Cron expression is required.";
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
    error.value = toErrorMessage(err, "Failed to create schedule.");
  } finally {
    creating.value = false;
  }
}
</script>

<template>
  <section>
    <FormPage max-width="28.75rem">
      <PageHeader title="New schedule" :back-link="{ to: '/schedules', label: 'Schedules' }" />
      <p class="hint">
        Automatically enables or disables a client or a single tool on a recurring schedule, evaluated once a minute in
        UTC on the leader instance.
      </p>

      <form class="create-form" @submit.prevent="createSchedule">
        <FormField label="Type" for="sched-type">
          <SelectMenu id="sched-type" v-model="targetType" :options="TARGET_TYPE_OPTIONS" />
        </FormField>
        <FormField label="Client" for="sched-client">
          <input id="sched-client" v-model="clientName" type="text" placeholder="client name" />
        </FormField>
        <FormField v-if="targetType === 'tool'" label="Tool" for="sched-tool">
          <input id="sched-tool" v-model="toolName" type="text" placeholder="tool name" />
        </FormField>
        <FormField label="Action" for="sched-action">
          <SelectMenu id="sched-action" v-model="action" :options="ACTION_OPTIONS" />
        </FormField>

        <FormField label="Frequency" for="sched-frequency">
          <SelectMenu id="sched-frequency" v-model="frequency" :options="FREQUENCY_OPTIONS" />
        </FormField>

        <FormField v-if="frequency === 'daily' || frequency === 'weekly'" label="Time" for="sched-time">
          <input id="sched-time" v-model="timeOfDay" type="time" />
        </FormField>

        <FormField v-if="frequency === 'weekly'" label="Days" for="sched-weekdays">
          <div id="sched-weekdays" class="weekday-picker" role="group" aria-label="Days of the week">
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

        <FormField v-if="frequency === 'hourly'" label="At minute" for="sched-minute">
          <SelectMenu id="sched-minute" v-model="minuteOfHour" :options="MINUTE_OPTIONS" />
        </FormField>

        <FormField v-if="frequency === 'custom'" label="Cron expression" for="sched-cron">
          <input id="sched-cron" v-model="customCron" type="text" placeholder="0 3 * * *" class="cron" />
          <p class="hint">Fields: <code>min hour day-of-month month day-of-week</code>.</p>
        </FormField>

        <p class="cron-preview">
          Runs: <strong>{{ cronPreview }}</strong>
          <span v-if="frequency !== 'custom'" class="cron-raw">({{ computedCron }})</span>
        </p>

        <p v-if="error" class="error">{{ error }}</p>
        <button class="btn-primary" type="submit" :disabled="creating">
          {{ creating ? "Creating…" : "Add schedule" }}
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
