<script setup lang="ts">
import { ref, onMounted } from "vue";
import { api } from "@/composables/useApi";
import { clientPath } from "@/utils/apiPaths";
import { useClearableConfig } from "@/composables/useClearableConfig";
import { useResource } from "@/composables/useResource";
import { usePatchResource } from "@/composables/usePatchResource";
import type { CanaryConfig } from "@/types/api";
import ConfirmDialog from "@/components/ui/ConfirmDialog.vue";
import ConfigSection from "./ConfigSection.vue";
import SelectMenu from "@/components/ui/SelectMenu.vue";

const props = defineProps<{ clientName: string }>();

const MODE_OPTIONS: { value: "canary" | "failover"; label: string }[] = [
  { value: "canary", label: "canary" },
  { value: "failover", label: "failover" },
];

const canaryForm = ref({ secondaryBaseUrl: "", mode: "canary" as "canary" | "failover", weight: 10, enabled: true });

const { data: canary, load: loadCanaryData } = useResource<CanaryConfig | null>(
  () => api.get<{ canary: CanaryConfig | null }>(clientPath(props.clientName, "canary")).then((res) => res.canary),
  null,
);

async function loadCanary() {
  const result = await loadCanaryData();
  if (result) {
    canaryForm.value = {
      secondaryBaseUrl: result.secondaryBaseUrl,
      mode: result.mode,
      weight: result.weight,
      enabled: result.enabled,
    };
  }
}
onMounted(loadCanary);

const { error: canaryError, run: runCanary } = usePatchResource(() => clientPath(props.clientName, "canary"));

async function saveCanary() {
  const ok = await runCanary((path) => api.put(path, { ...canaryForm.value }), "Failed to save.");
  if (ok) await loadCanary();
}

const {
  pendingClear: pendingClearCanary,
  requestClear,
  cancelClear: cancelClearCanary,
  confirmClear,
  error: clearCanaryError,
} = useClearableConfig(
  loadCanary,
  () => api.put(clientPath(props.clientName, "canary"), { canary: null }),
  "Failed to clear.",
);
</script>

<template>
  <ConfigSection title="Canary / failover">
    <template v-if="canary" #actions>
      <button type="button" class="link-btn danger" @click="requestClear">Clear</button>
    </template>
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
        <SelectMenu v-model="canaryForm.mode" :options="MODE_OPTIONS" />
      </label>
      <label
        >Weight percent
        <input v-model.number="canaryForm.weight" type="number" min="1" max="100" style="max-width: 5.625rem"
      /></label>
      <label class="inline-check"><input v-model="canaryForm.enabled" type="checkbox" /> enabled</label>
      <button type="submit" class="btn-secondary">Save canary config</button>
    </form>
    <p v-if="canaryError || clearCanaryError" class="error">{{ canaryError || clearCanaryError }}</p>
  </ConfigSection>

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
