<script setup lang="ts">
import { ref, onMounted } from "vue";
import { api } from "@/composables/useApi";
import { clientPath } from "@/utils/apiPaths";
import { useConfirmAction } from "@/composables/useConfirmAction";
import { useResource } from "@/composables/useResource";
import { usePatchResource } from "@/composables/usePatchResource";
import { toErrorMessage } from "@/utils/errors";
import type { LbConfig, LbStrategy, LbTarget } from "@/types/api";
import ConfirmDialog from "@/components/ui/ConfirmDialog.vue";
import ConfigSection from "./ConfigSection.vue";

const props = defineProps<{ clientName: string }>();

const lbForm = ref<{ strategy: LbStrategy; primaryWeight: number; enabled: boolean }>({
  strategy: "round-robin",
  primaryWeight: 1,
  enabled: true,
});

const { data: lb, load: loadLbData } = useResource<LbConfig | null>(
  () => api.get<{ lb: LbConfig | null }>(clientPath(props.clientName, "lb")).then((res) => res.lb),
  null,
);

async function loadLb() {
  const result = await loadLbData();
  if (result) {
    lbForm.value = { strategy: result.strategy, primaryWeight: result.primaryWeight, enabled: result.enabled };
  }
}
onMounted(loadLb);

const { saving: lbSaving, error: lbError, run: runLb } = usePatchResource(() => clientPath(props.clientName, "lb"));

async function saveLb() {
  const ok = await runLb((path) => api.put(path, { ...lbForm.value }), "Failed to save.");
  if (ok) await loadLb();
}

const {
  pending: pendingClearLb,
  request: requestClearLbConfirm,
  cancel: cancelClearLb,
  confirm: confirmClearLbAction,
} = useConfirmAction<true>();

function requestClearLb() {
  requestClearLbConfirm(true);
}

function confirmClearLb() {
  return confirmClearLbAction(async () => {
    try {
      await api.put(clientPath(props.clientName, "lb"), { lb: null });
      lb.value = null;
    } catch (err) {
      lbError.value = toErrorMessage(err, "Failed to clear.");
    }
  });
}

const newTargetUrl = ref("");
const newTargetWeight = ref(1);
const { saving: addingTarget, error: targetError, run: runAddTarget } = usePatchResource(() =>
  clientPath(props.clientName, "lb", "upstreams"),
);
async function addTarget() {
  if (!newTargetUrl.value.trim()) {
    targetError.value = "Base URL is required.";
    return;
  }
  const ok = await runAddTarget(
    (path) => api.post(path, { baseUrl: newTargetUrl.value.trim(), weight: newTargetWeight.value }),
    "Failed to add target.",
  );
  if (ok) {
    newTargetUrl.value = "";
    newTargetWeight.value = 1;
    await loadLb();
  }
}

const targetRowError = ref<Record<number, string>>({});
const savingTargetId = ref<number | null>(null);
async function updateTargetWeight(t: LbTarget, weight: number) {
  if (!Number.isInteger(weight) || weight < 1) {
    targetRowError.value = { ...targetRowError.value, [t.id]: "Weight must be a whole number of at least 1." };
    return;
  }
  savingTargetId.value = t.id;
  targetRowError.value = { ...targetRowError.value, [t.id]: "" };
  try {
    await api.patch(clientPath(props.clientName, "lb", "upstreams", String(t.id)), { weight });
    await loadLb();
  } catch (err) {
    targetRowError.value = {
      ...targetRowError.value,
      [t.id]: toErrorMessage(err, "Failed to update target."),
    };
  } finally {
    savingTargetId.value = null;
  }
}
async function toggleTargetEnabled(t: LbTarget) {
  savingTargetId.value = t.id;
  targetRowError.value = { ...targetRowError.value, [t.id]: "" };
  try {
    await api.patch(clientPath(props.clientName, "lb", "upstreams", String(t.id)), { enabled: !t.enabled });
    await loadLb();
  } catch (err) {
    targetRowError.value = {
      ...targetRowError.value,
      [t.id]: toErrorMessage(err, "Failed to update target."),
    };
  } finally {
    savingTargetId.value = null;
  }
}

const {
  pending: pendingRemoveTarget,
  request: requestRemoveTarget,
  cancel: cancelRemoveTarget,
  confirm: confirmRemoveTargetAction,
} = useConfirmAction<LbTarget>();

function confirmRemoveTarget() {
  return confirmRemoveTargetAction(async (t) => {
    try {
      await api.delete(clientPath(props.clientName, "lb", "upstreams", String(t.id)));
      await loadLb();
    } catch (err) {
      lbError.value = toErrorMessage(err, "Failed to remove target.");
    }
  });
}
</script>

<template>
  <ConfigSection title="Load balancing">
    <template v-if="lb" #actions>
      <button type="button" class="link-btn danger" @click="requestClearLb">Clear</button>
    </template>
    <p class="ua-status">
      Spread calls across the primary backend plus an N-way pool of additional targets. Takes precedence over
      canary/failover below — while an enabled pool has at least one enabled target, canary routing is skipped entirely
      for this server.
      <template v-if="lb">
        Currently: <code>{{ lb.strategy }}</code
        >, primary weight {{ lb.primaryWeight }}, {{ lb.enabled ? "enabled" : "disabled" }},
        {{ lb.targets.length }} target{{ lb.targets.length === 1 ? "" : "s" }}.</template
      >
    </p>
    <form class="ua-form" @submit.prevent="saveLb">
      <label
        >Strategy
        <select v-model="lbForm.strategy">
          <option value="round-robin">round-robin</option>
          <option value="weighted">weighted</option>
          <option value="least-conn">least-conn</option>
        </select>
      </label>
      <label>Primary weight <input v-model.number="lbForm.primaryWeight" type="number" min="0" max="1000" /></label>
      <label class="inline-check"><input v-model="lbForm.enabled" type="checkbox" /> enabled</label>
      <button type="submit" class="btn-secondary" :disabled="lbSaving">
        {{ lbSaving ? "Saving…" : "Save pool config" }}
      </button>
    </form>
    <p v-if="lbError" class="error">{{ lbError }}</p>

    <template v-if="lb">
      <div class="table-card table-scroll lb-targets">
        <table class="lb-table">
          <thead>
            <tr>
              <th>Base URL</th>
              <th>Weight</th>
              <th>Enabled</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="t in lb.targets" :key="t.id">
              <td class="url-cell" :title="t.baseUrl">{{ t.baseUrl }}</td>
              <td>
                <input
                  type="number"
                  min="1"
                  max="1000"
                  :value="t.weight"
                  :disabled="savingTargetId === t.id"
                  style="max-width: 5rem"
                  @change="updateTargetWeight(t, Number(($event.target as HTMLInputElement).value))"
                />
              </td>
              <td>
                <button
                  type="button"
                  class="toggle"
                  :class="t.enabled ? 'toggle-on' : 'toggle-off'"
                  :aria-pressed="t.enabled"
                  :disabled="savingTargetId === t.id"
                  @click="toggleTargetEnabled(t)"
                >
                  {{ t.enabled ? "Enabled" : "Disabled" }}
                </button>
              </td>
              <td>
                <button type="button" class="link-btn danger" @click="requestRemoveTarget(t)">Remove</button>
                <p v-if="targetRowError[t.id]" class="row-error">{{ targetRowError[t.id] }}</p>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-if="!lb.targets.length" class="ua-status">No pool targets yet — add one below.</p>

      <form class="ua-form" @submit.prevent="addTarget">
        <label
          >Target base URL <input v-model="newTargetUrl" type="url" placeholder="https://api-2.example.com"
        /></label>
        <label>Weight <input v-model.number="newTargetWeight" type="number" min="1" max="1000" /></label>
        <p v-if="targetError" class="error">{{ targetError }}</p>
        <button type="submit" class="btn-secondary" :disabled="addingTarget">
          {{ addingTarget ? "Adding…" : "Add target" }}
        </button>
      </form>
    </template>
  </ConfigSection>

  <ConfirmDialog
    :open="pendingClearLb !== null"
    title="Clear load-balancing pool config?"
    message="This removes the pool strategy config for this server, but keeps the individual targets stored — routing falls back to the primary backend only (and canary/failover, if configured) until you reconfigure the pool."
    confirm-label="Clear pool config"
    danger
    @confirm="confirmClearLb"
    @cancel="cancelClearLb"
  />

  <ConfirmDialog
    :open="pendingRemoveTarget !== null"
    title="Remove this pool target?"
    :message="
      pendingRemoveTarget
        ? `'${pendingRemoveTarget.baseUrl}' will stop receiving traffic immediately. If it's actively serving calls, in-flight requests to it are unaffected but no new ones will be routed there.`
        : ''
    "
    confirm-label="Remove target"
    danger
    @confirm="confirmRemoveTarget"
    @cancel="cancelRemoveTarget"
  />
</template>
