<script setup lang="ts">
import { ref, onMounted } from "vue";
import { useI18n } from "vue-i18n";
import { api } from "@/composables/useApi";
import { clientPath } from "@/utils/apiPaths";
import { useClearableConfig } from "@/composables/useClearableConfig";
import { useResource } from "@/composables/useResource";
import { usePatchResource } from "@/composables/usePatchResource";
import { tk } from "@/i18n";
import type { CanaryConfig } from "@/types/api";
import ConfirmDialog from "@/components/ui/ConfirmDialog.vue";
import ConfigSection from "./ConfigSection.vue";
import SelectMenu from "@/components/ui/SelectMenu.vue";
import FieldError from "@/components/ui/FieldError.vue";

const props = defineProps<{ clientName: string }>();
const { t } = useI18n({ useScope: "global" });

const MODE_OPTIONS: { value: "canary" | "failover"; label: string }[] = [
  { value: "canary", label: t("components.server_detail_canary.mode.canary") },
  { value: "failover", label: t("components.server_detail_canary.mode.failover") },
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
  const ok = await runCanary(
    (path) => api.put(path, { ...canaryForm.value }),
    tk("components.server_detail_canary.errors.save_failed"),
  );
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
  tk("components.server_detail_canary.errors.clear_failed"),
);
</script>

<template>
  <ConfigSection :title="t('components.server_detail_canary.title')">
    <template v-if="canary" #actions>
      <button type="button" class="link-btn danger" @click="requestClear">
        {{ t("components.server_detail_canary.clear") }}
      </button>
    </template>
    <p class="ua-status">
      {{ t("components.server_detail_canary.hint") }}
      <template v-if="canary">
        {{
          t("components.server_detail_canary.currently", {
            mode: canary.mode,
            url: canary.secondaryBaseUrl,
            weight: canary.weight,
            enabled: canary.enabled
              ? t("components.server_detail_canary.enabled")
              : t("components.server_detail_canary.disabled"),
          })
        }}
      </template>
      {{ t("components.server_detail_canary.note") }}
    </p>
    <form class="ua-form" @submit.prevent="saveCanary">
      <label
        >{{ t("components.server_detail_canary.fields.secondary_url") }}
        <input v-model="canaryForm.secondaryBaseUrl" type="url" placeholder="https://v2.api.example.com"
      /></label>
      <label
        >{{ t("components.server_detail_canary.fields.mode") }}
        <SelectMenu v-model="canaryForm.mode" :options="MODE_OPTIONS" />
      </label>
      <label
        >{{ t("components.server_detail_canary.fields.weight") }}
        <input v-model.number="canaryForm.weight" type="number" min="1" max="100" style="max-width: 5.625rem"
      /></label>
      <label class="inline-check"
        ><input v-model="canaryForm.enabled" type="checkbox" />
        {{ t("components.server_detail_canary.fields.enabled") }}</label
      >
      <button type="submit" class="btn-secondary">{{ t("components.server_detail_canary.save") }}</button>
    </form>
    <FieldError :message="canaryError || clearCanaryError" />
  </ConfigSection>

  <ConfirmDialog
    :open="pendingClearCanary !== null"
    :title="t('components.server_detail_canary.confirm.clear_title')"
    :message="t('components.server_detail_canary.confirm.clear_message')"
    :confirm-label="t('components.server_detail_canary.confirm.clear_cta')"
    danger
    @confirm="confirmClear"
    @cancel="cancelClearCanary"
  />
</template>
