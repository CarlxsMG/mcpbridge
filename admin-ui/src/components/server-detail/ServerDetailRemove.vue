<script setup lang="ts">
import { ref } from "vue";
import { useI18n } from "vue-i18n";
import { useRouter } from "vue-router";
import { api } from "@/composables/useApi";
import { useConfirmAction } from "@/composables/useConfirmAction";
import { toErrorMessage } from "@/utils/errors";
import { tk } from "@/i18n";
import { clientPath } from "@/utils/apiPaths";
import ConfirmDialog from "@/components/ui/ConfirmDialog.vue";
import ConfigSection from "./ConfigSection.vue";

const props = defineProps<{ clientName: string }>();
const router = useRouter();
const { t } = useI18n({ useScope: "global" });
const removeError = ref("");

const {
  pending: pendingRemoveServer,
  request: requestRemoveServerConfirm,
  cancel: cancelRemoveServer,
  confirm: confirmRemoveServerAction,
} = useConfirmAction<true>();

function requestRemoveServer() {
  requestRemoveServerConfirm(true);
}

function confirmRemoveServer() {
  return confirmRemoveServerAction(async () => {
    try {
      await api.delete(clientPath(props.clientName));
      router.push("/servers");
    } catch (err) {
      removeError.value = toErrorMessage(err, tk("components.server_detail_remove.errors.remove_failed"));
    }
  });
}
</script>

<template>
  <ConfigSection :title="t('components.server_detail_remove.title')">
    <p class="ua-status">
      {{ t("components.server_detail_remove.hint") }}
    </p>
    <button type="button" class="btn-danger" @click="requestRemoveServer">
      {{ t("components.server_detail_remove.button") }}
    </button>
    <p v-if="removeError" class="error">{{ removeError }}</p>
  </ConfigSection>

  <ConfirmDialog
    :open="pendingRemoveServer !== null"
    :title="t('components.server_detail_remove.confirm.title')"
    :message="t('components.server_detail_remove.confirm.message', { name: clientName })"
    :confirm-label="t('components.server_detail_remove.confirm.cta', { name: clientName })"
    danger
    @confirm="confirmRemoveServer"
    @cancel="cancelRemoveServer"
  />
</template>
