<script setup lang="ts">
// First-run onboarding checklist for the Servers (dashboard) page — lowers
// time-to-first-value for a fresh self-hoster by surfacing the handful of
// steps that make this instance actually useful, with real-data checkmarks
// rather than a generic static tour.
//
// Zero new backend state: every derived step reuses an admin-api list/summary
// endpoint that already exists, and dismissal is a localStorage flag (not
// worth a DB migration).
import { computed, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { api } from "@/composables/useApi";
import type { OverviewStats, UsageSummary } from "@/types/api";
import { CheckCircle2, Circle } from "lucide-vue-next";

const props = defineProps<{
  /** Servers list is already fetched by ServersPage — avoid a second /admin-api/clients call. */
  hasServers: boolean;
}>();
const { t } = useI18n({ useScope: "global" });

const DISMISSED_KEY = "mcpbridge.onboarding.dismissed";
const CLIENT_CONNECTED_KEY = "mcpbridge.onboarding.clientConnected";

const dismissed = ref(localStorage.getItem(DISMISSED_KEY) === "1");
const clientConnected = ref(localStorage.getItem(CLIENT_CONNECTED_KEY) === "1");

const toolTested = ref(false);
const teammateInvited = ref(false);

async function loadSignals(): Promise<void> {
  try {
    const usage = await api.get<UsageSummary>("/admin-api/usage/summary?from=0");
    toolTested.value = usage.calls > 0;
  } catch {
    // leave unchecked
  }
  try {
    const overview = await api.get<OverviewStats>("/admin-api/overview");
    teammateInvited.value = overview.admin_users > 1;
  } catch {
    // leave unchecked
  }
}

onMounted(() => {
  if (!dismissed.value) loadSignals();
});

function toggleClientConnected(): void {
  clientConnected.value = !clientConnected.value;
  localStorage.setItem(CLIENT_CONNECTED_KEY, clientConnected.value ? "1" : "0");
}

function dismiss(): void {
  dismissed.value = true;
  localStorage.setItem(DISMISSED_KEY, "1");
}

interface Step {
  id: string;
  label: string;
  done: boolean;
  /** Manual steps are self-reported by the user (click to toggle) rather than derived from data. */
  manual?: boolean;
}

const steps = computed<Step[]>(() => [
  { id: "server", label: t("components.onboarding.steps.register_server"), done: props.hasServers },
  { id: "tool", label: t("components.onboarding.steps.test_tool"), done: toolTested.value },
  { id: "client", label: t("components.onboarding.steps.connect_client"), done: clientConnected.value, manual: true },
  { id: "teammate", label: t("components.onboarding.steps.invite_teammate"), done: teammateInvited.value },
]);

const doneCount = computed(() => steps.value.filter((s) => s.done).length);
const allDone = computed(() => doneCount.value === steps.value.length);
</script>

<template>
  <div v-if="!dismissed" class="onboarding-card">
    <div class="onboarding-head">
      <div>
        <h2>{{ t('components.onboarding.title') }}</h2>
        <p class="subtitle">
          {{ allDone ? t('components.onboarding.all_done') : t('components.onboarding.progress', { done: doneCount, total: steps.length }) }}
        </p>
      </div>
      <button type="button" class="link-btn" @click="dismiss">{{ t('components.onboarding.dismiss') }}</button>
    </div>
    <ul class="onboarding-steps">
      <li v-for="step in steps" :key="step.id" :class="{ 'step-done': step.done }">
        <button
          v-if="step.manual"
          type="button"
          class="step-row step-toggle"
          :aria-pressed="step.done"
          @click="toggleClientConnected"
        >
          <CheckCircle2 v-if="step.done" :size="16" stroke-width="2" aria-hidden="true" class="step-icon-done" />
          <Circle v-else :size="16" stroke-width="2" aria-hidden="true" class="step-icon-todo" />
          <span>{{ step.label }}</span>
        </button>
        <span v-else class="step-row">
          <CheckCircle2 v-if="step.done" :size="16" stroke-width="2" aria-hidden="true" class="step-icon-done" />
          <Circle v-else :size="16" stroke-width="2" aria-hidden="true" class="step-icon-todo" />
          <span>{{ step.label }}</span>
        </span>

        <RouterLink v-if="step.id === 'server' && !step.done" to="/register-server" class="step-cta">
          {{ t('components.onboarding.cta.add_server') }}
        </RouterLink>
        <RouterLink v-if="step.id === 'teammate' && !step.done" to="/users/new" class="step-cta">{{ t('components.onboarding.cta.invite') }}</RouterLink>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.onboarding-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-xs);
  padding: var(--space-4) var(--space-5);
  margin-bottom: var(--space-6);
}
.onboarding-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: var(--space-3);
  margin-bottom: var(--space-3);
}
.onboarding-head h2 {
  margin: 0 0 0.15rem;
  font-size: var(--text-lg);
}
.onboarding-head .subtitle {
  margin: 0;
  color: var(--text-secondary);
  font-size: var(--text-sm);
}
.onboarding-steps {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
}
.onboarding-steps li {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-2) 0;
  border-bottom: 1px solid var(--border);
  font-size: var(--text-base);
}
.onboarding-steps li:last-child {
  border-bottom: none;
  padding-bottom: 0;
}
.step-row {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
  color: var(--text-primary);
}
.step-done .step-row {
  color: var(--text-secondary);
}
.step-icon-done {
  color: var(--ok);
  flex-shrink: 0;
}
.step-icon-todo {
  color: var(--text-muted);
  flex-shrink: 0;
}
.step-toggle {
  background: none;
  border: none;
  padding: 0;
  cursor: pointer;
  font-family: var(--font-body);
  text-align: left;
}
.step-toggle:hover {
  color: var(--signal-strong);
}
.step-cta {
  flex-shrink: 0;
  font-size: var(--text-sm);
  font-weight: 600;
  color: var(--signal-strong);
  white-space: nowrap;
}
</style>