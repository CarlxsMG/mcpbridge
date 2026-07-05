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
import { api } from "@/composables/useApi";
import type { OverviewStats, UsageSummary } from "@/types/api";
import { CheckCircle2, Circle } from "lucide-vue-next";

const props = defineProps<{
  /** Servers list is already fetched by ServersPage — avoid a second /admin-api/clients call. */
  hasServers: boolean;
}>();

const DISMISSED_KEY = "mcpbridge.onboarding.dismissed";
// No client-config-generator feature exists yet to hook into (see task notes) — this is a
// plain manual toggle for now. If/when that feature lands, prefer reusing this same key over
// inventing a second one, so a user who already checked this off by hand isn't asked again.
const CLIENT_CONNECTED_KEY = "mcpbridge.onboarding.clientConnected";

const dismissed = ref(localStorage.getItem(DISMISSED_KEY) === "1");
const clientConnected = ref(localStorage.getItem(CLIENT_CONNECTED_KEY) === "1");

// Best-effort signals — a failed fetch just leaves the step unchecked rather than
// surfacing a second error banner on top of the dashboard's own.
const toolTested = ref(false);
const teammateInvited = ref(false);

async function loadSignals(): Promise<void> {
  try {
    // from=0 (epoch) turns the usual rolling default window into an all-time total —
    // the cheapest accurate "has any tool ever been called" signal this endpoint can give
    // without a new backend route.
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
  { id: "server", label: "Register your first server", done: props.hasServers },
  { id: "tool", label: "Test a tool", done: toolTested.value },
  { id: "client", label: "Connect a client", done: clientConnected.value, manual: true },
  { id: "teammate", label: "Invite a teammate", done: teammateInvited.value },
]);

const doneCount = computed(() => steps.value.filter((s) => s.done).length);
const allDone = computed(() => doneCount.value === steps.value.length);
</script>

<template>
  <div v-if="!dismissed" class="onboarding-card">
    <div class="onboarding-head">
      <div>
        <h2>Get started</h2>
        <p class="subtitle">
          {{ allDone ? "All steps complete — nice work." : `${doneCount} of ${steps.length} done` }}
        </p>
      </div>
      <button type="button" class="link-btn" @click="dismiss">Dismiss</button>
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
          Add a server
        </RouterLink>
        <RouterLink v-if="step.id === 'teammate' && !step.done" to="/users/new" class="step-cta">Invite</RouterLink>
      </li>
    </ul>
  </div>
</template>

<style scoped>
/* Same card recipe as .tag-browser / .chart-card (DESIGN_SYSTEM.md) — reused verbatim. */
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
