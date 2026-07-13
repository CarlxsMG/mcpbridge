<script setup lang="ts">
import { ref, onMounted } from "vue";
import { useI18n } from "vue-i18n";
import { api } from "@/composables/useApi";
import { clientPath } from "@/utils/apiPaths";
import { useConfirmAction } from "@/composables/useConfirmAction";
import { useClearableConfig } from "@/composables/useClearableConfig";
import { useResource } from "@/composables/useResource";
import { usePatchResource } from "@/composables/usePatchResource";
import { tk } from "@/i18n";
import type { LbConfig, LbStrategy, LbTarget } from "@/types/api";
import ConfirmDialog from "@/components/ui/ConfirmDialog.vue";
import ConfigSection from "./ConfigSection.vue";
import SelectMenu from "@/components/ui/SelectMenu.vue";
import TableCard from "@/components/ui/TableCard.vue";
import FieldError from "@/components/ui/FieldError.vue";
import HoverPreview from "@/components/ui/HoverPreview.vue";
import TogglePill from "@/components/ui/TogglePill.vue";

const props = defineProps<{ clientName: string }>();
const { t } = useI18n({ useScope: "global" });

const STRATEGY_OPTIONS: { value: LbStrategy; label: string }[] = [
  { value: "round-robin", label: t("components.server_detail_lb.strategy.round_robin") },
  { value: "weighted", label: t("components.server_detail_lb.strategy.weighted") },
  { value: "least-conn", label: t("components.server_detail_lb.strategy.least_conn") },
];

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
  const ok = await runLb(
    (path) => api.put(path, { ...lbForm.value }),
    tk("components.server_detail_lb.errors.save_failed"),
  );
  if (ok) await loadLb();
}

const {
  pendingClear: pendingClearLb,
  requestClear: requestClearLb,
  cancelClear: cancelClearLb,
  confirmClear: confirmClearLb,
  error: clearLbError,
} = useClearableConfig(
  loadLb,
  () => api.put(clientPath(props.clientName, "lb"), { lb: null }),
  tk("components.server_detail_lb.errors.clear_failed"),
);

const newTargetUrl = ref("");
const newTargetWeight = ref(1);
const {
  saving: addingTarget,
  error: targetError,
  run: runAddTarget,
} = usePatchResource(() => clientPath(props.clientName, "lb", "upstreams"));
async function addTarget() {
  if (!newTargetUrl.value.trim()) {
    targetError.value = t("components.server_detail_lb.errors.base_url_required");
    return;
  }
  const ok = await runAddTarget(
    (path) => api.post(path, { baseUrl: newTargetUrl.value.trim(), weight: newTargetWeight.value }),
    tk("components.server_detail_lb.errors.add_failed"),
  );
  if (ok) {
    newTargetUrl.value = "";
    newTargetWeight.value = 1;
    await loadLb();
  }
}

const targetRowError = ref<Record<number, string>>({});
const savingTargetId = ref<number | null>(null);
const { error: targetRowErrorMessage, run: runTarget } = usePatchResource(() =>
  clientPath(props.clientName, "lb", "upstreams"),
);

async function updateTargetWeight(target: LbTarget, weight: number) {
  if (!Number.isInteger(weight) || weight < 1) {
    targetRowError.value = {
      ...targetRowError.value,
      [target.id]: t("components.server_detail_lb.errors.weight_invalid"),
    };
    return;
  }
  savingTargetId.value = target.id;
  targetRowError.value = { ...targetRowError.value, [target.id]: "" };
  const ok = await runTarget(
    (path) => api.patch(`${path}/${target.id}`, { weight }),
    tk("components.server_detail_lb.errors.update_target_failed"),
  );
  if (ok) await loadLb();
  else targetRowError.value = { ...targetRowError.value, [target.id]: targetRowErrorMessage.value };
  savingTargetId.value = null;
}
async function toggleTargetEnabled(target: LbTarget) {
  savingTargetId.value = target.id;
  targetRowError.value = { ...targetRowError.value, [target.id]: "" };
  const ok = await runTarget(
    (path) => api.patch(`${path}/${target.id}`, { enabled: !target.enabled }),
    tk("components.server_detail_lb.errors.update_target_failed"),
  );
  if (ok) await loadLb();
  else targetRowError.value = { ...targetRowError.value, [target.id]: targetRowErrorMessage.value };
  savingTargetId.value = null;
}

const {
  pending: pendingRemoveTarget,
  request: requestRemoveTarget,
  cancel: cancelRemoveTarget,
  confirm: confirmRemoveTargetAction,
} = useConfirmAction<LbTarget>();

function confirmRemoveTarget() {
  return confirmRemoveTargetAction(async (target) => {
    const ok = await runTarget(
      (path) => api.delete(`${path}/${target.id}`),
      tk("components.server_detail_lb.errors.remove_failed"),
    );
    if (ok) await loadLb();
    else lbError.value = targetRowErrorMessage.value;
  });
}
</script>

<template>
  <ConfigSection :title="t('components.server_detail_lb.title')">
    <template v-if="lb" #actions>
      <button type="button" class="link-btn danger" @click="requestClearLb">
        {{ t("components.server_detail_lb.clear") }}
      </button>
    </template>
    <p class="ua-status">
      {{ t("components.server_detail_lb.hint") }}
      <template v-if="lb">
        {{
          t("components.server_detail_lb.currently", {
            strategy: lb.strategy,
            weight: lb.primaryWeight,
            enabled: lb.enabled ? t("components.server_detail_lb.enabled") : t("components.server_detail_lb.disabled"),
            count: lb.targets.length,
          })
        }}
      </template>
    </p>
    <form class="ua-form" @submit.prevent="saveLb">
      <label
        >{{ t("components.server_detail_lb.fields.strategy") }}
        <SelectMenu v-model="lbForm.strategy" :options="STRATEGY_OPTIONS" />
      </label>
      <label
        >{{ t("components.server_detail_lb.fields.primary_weight") }}
        <input v-model.number="lbForm.primaryWeight" type="number" min="0" max="1000"
      /></label>
      <label class="inline-check"
        ><input v-model="lbForm.enabled" type="checkbox" /> {{ t("components.server_detail_lb.fields.enabled") }}</label
      >
      <button type="submit" class="btn-secondary" :disabled="lbSaving">
        {{ lbSaving ? t("common.saving") : t("components.server_detail_lb.save_pool") }}
      </button>
    </form>
    <FieldError :message="lbError || clearLbError" />

    <template v-if="lb">
      <TableCard class="lb-targets">
        <thead>
          <tr>
            <th>{{ t("components.server_detail_lb.table.base_url") }}</th>
            <th>{{ t("components.server_detail_lb.table.weight") }}</th>
            <th>{{ t("components.server_detail_lb.table.enabled") }}</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="target in lb.targets" :key="target.id">
            <td>
              <HoverPreview class="url-cell" :text="target.baseUrl" mono>{{ target.baseUrl }}</HoverPreview>
            </td>
            <td>
              <input
                type="number"
                min="1"
                max="1000"
                :value="target.weight"
                :disabled="savingTargetId === target.id"
                style="max-width: 5rem"
                @change="updateTargetWeight(target, Number(($event.target as HTMLInputElement).value))"
              />
            </td>
            <td>
              <TogglePill
                :on="target.enabled"
                :on-label="t('common.enabled')"
                :off-label="t('common.disabled')"
                :disabled="savingTargetId === target.id"
                @click="toggleTargetEnabled(target)"
              />
            </td>
            <td>
              <button type="button" class="link-btn danger" @click="requestRemoveTarget(target)">
                {{ t("components.server_detail_lb.remove") }}
              </button>
              <p v-if="targetRowError[target.id]" class="row-error">{{ targetRowError[target.id] }}</p>
            </td>
          </tr>
        </tbody>
      </TableCard>
      <p v-if="!lb.targets.length" class="ua-status">{{ t("components.server_detail_lb.empty_targets") }}</p>

      <form class="ua-form" @submit.prevent="addTarget">
        <label
          >{{ t("components.server_detail_lb.fields.target_url") }}
          <input v-model="newTargetUrl" type="url" placeholder="https://api-2.example.com"
        /></label>
        <label
          >{{ t("components.server_detail_lb.fields.weight") }}
          <input v-model.number="newTargetWeight" type="number" min="1" max="1000"
        /></label>
        <FieldError :message="targetError" />
        <button type="submit" class="btn-secondary" :disabled="addingTarget">
          {{ addingTarget ? t("components.server_detail_lb.adding") : t("components.server_detail_lb.add_target") }}
        </button>
      </form>
    </template>
  </ConfigSection>

  <ConfirmDialog
    :open="pendingClearLb !== null"
    :title="t('components.server_detail_lb.confirm.clear_title')"
    :message="t('components.server_detail_lb.confirm.clear_message')"
    :confirm-label="t('components.server_detail_lb.confirm.clear_cta')"
    danger
    @confirm="confirmClearLb"
    @cancel="cancelClearLb"
  />

  <ConfirmDialog
    :open="pendingRemoveTarget !== null"
    :title="t('components.server_detail_lb.confirm.remove_title')"
    :message="
      pendingRemoveTarget
        ? t('components.server_detail_lb.confirm.remove_message', { url: pendingRemoveTarget.baseUrl })
        : ''
    "
    :confirm-label="t('components.server_detail_lb.confirm.remove_cta')"
    danger
    @confirm="confirmRemoveTarget"
    @cancel="cancelRemoveTarget"
  />
</template>
