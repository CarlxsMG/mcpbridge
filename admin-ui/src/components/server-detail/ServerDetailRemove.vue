<script setup lang="ts">
import { ref } from "vue";
import { useRouter } from "vue-router";
import { api } from "@/composables/useApi";
import { useConfirmAction } from "@/composables/useConfirmAction";
import { toErrorMessage } from "@/utils/errors";
import ConfirmDialog from "@/components/ui/ConfirmDialog.vue";
import ConfigSection from "./ConfigSection.vue";

const props = defineProps<{ clientName: string }>();
const router = useRouter();
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
      await api.delete(`/admin-api/clients/${encodeURIComponent(props.clientName)}`);
      router.push("/servers");
    } catch (err) {
      removeError.value = toErrorMessage(err, "Failed to remove server.");
    }
  });
}
</script>

<template>
  <ConfigSection title="Remove server">
    <p class="ua-status">
      Unlike Disable above, this permanently deletes the server's registration, guards, and all per-tool configuration.
      Connected MCP agents lose access to its tools immediately, and this can't be undone — Disable above is the
      reversible alternative.
    </p>
    <button type="button" class="btn-danger" @click="requestRemoveServer">Remove server</button>
    <p v-if="removeError" class="error">{{ removeError }}</p>
  </ConfigSection>

  <ConfirmDialog
    :open="pendingRemoveServer !== null"
    title="Remove this server?"
    :message="`This permanently deletes the registration, guards, and all per-tool configuration for '${clientName}'. Connected MCP agents lose access to its tools immediately. This can't be undone.`"
    :confirm-label="`Remove ${clientName}`"
    danger
    @confirm="confirmRemoveServer"
    @cancel="cancelRemoveServer"
  />
</template>
