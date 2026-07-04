<script setup lang="ts">
import { ref, onMounted } from "vue";
import { api, ApiError } from "../composables/useApi";
import { clientPath } from "../composables/apiPaths";
import { useConfirmAction } from "../composables/useConfirmAction";
import type { CanaryConfig } from "../types/api";
import ConfirmDialog from "./ConfirmDialog.vue";

const props = defineProps<{ clientName: string }>();

const canary = ref<CanaryConfig | null>(null);
const canaryForm = ref({ secondaryBaseUrl: "", mode: "canary" as "canary" | "failover", weight: 10, enabled: true });
const canaryError = ref("");

async function loadCanary() {
  try {
    const res = await api.get<{ canary: CanaryConfig | null }>(clientPath(props.clientName, "canary"));
    canary.value = res.canary;
    if (res.canary)
      canaryForm.value = {
        secondaryBaseUrl: res.canary.secondaryBaseUrl,
        mode: res.canary.mode,
        weight: res.canary.weight,
        enabled: res.canary.enabled,
      };
  } catch {
    canary.value = null;
  }
}
onMounted(loadCanary);

async function saveCanary() {
  canaryError.value = "";
  try {
    await api.put(clientPath(props.clientName, "canary"), { ...canaryForm.value });
    await loadCanary();
  } catch (err) {
    canaryError.value = err instanceof ApiError ? err.message : "Failed to save.";
  }
}

const { pending: pendingClearCanary, request: requestClearCanary, cancel: cancelClearCanary, confirm: confirmClearCanaryAction } =
  useConfirmAction<true>();

function requestClear() {
  requestClearCanary(true);
}

function confirmClear() {
  return confirmClearCanaryAction(async () => {
    canaryError.value = "";
    try {
      await api.put(clientPath(props.clientName, "canary"), { canary: null });
      canary.value = null;
    } catch (err) {
      canaryError.value = err instanceof ApiError ? err.message : "Failed to clear.";
    }
  });
}
</script>

<template>
  <div class="upstream-auth">
    <div class="ua-head">
      <h2>Canary / failover</h2>
      <button v-if="canary" type="button" class="link-btn danger" @click="requestClear">Clear</button>
    </div>
    <p class="ua-status">
      Route to a secondary backend. <strong>canary</strong>: send a % of calls there; <strong>failover</strong>: route
      there only while the primary breaker is open.
      <template v-if="canary">
        Currently: <code>{{ canary.mode }}</code> → <code>{{ canary.secondaryBaseUrl }}</code> ({{ canary.weight }}%,
        {{ canary.enabled ? "enabled" : "disabled" }}).</template
      >
      Note: Load balancing above takes precedence — when an enabled pool has at least one enabled target, this
      canary/failover config is bypassed.
    </p>
    <form class="ua-form" @submit.prevent="saveCanary">
      <label
        >Secondary base URL
        <input v-model="canaryForm.secondaryBaseUrl" type="url" placeholder="https://v2.api.example.com"
      /></label>
      <label
        >Mode
        <select v-model="canaryForm.mode">
          <option value="canary">canary</option>
          <option value="failover">failover</option>
        </select>
      </label>
      <label
        >Weight percent
        <input v-model.number="canaryForm.weight" type="number" min="1" max="100" style="max-width: 5.625rem"
      /></label>
      <label class="inline-check"><input v-model="canaryForm.enabled" type="checkbox" /> enabled</label>
      <button type="submit" class="btn-secondary">Save canary config</button>
    </form>
    <p v-if="canaryError" class="error">{{ canaryError }}</p>
  </div>

  <ConfirmDialog
    :open="pendingClearCanary !== null"
    title="Clear canary / failover config?"
    message="This removes the secondary backend routing configuration. This can't be undone — you'll need to reconfigure it to restore this setup."
    confirm-label="Clear canary config"
    danger
    @confirm="confirmClear"
    @cancel="cancelClearCanary"
  />
</template>
