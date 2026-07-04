<script setup lang="ts">
import { ref, onMounted } from "vue";
import { api, ApiError } from "@/composables/useApi";
import { clientPath } from "@/utils/apiPaths";
import { useConfirmAction } from "@/composables/useConfirmAction";
import type { UpstreamAuthInfo, UpstreamKind } from "@/types/api";
import ConfirmDialog from "@/components/ui/ConfirmDialog.vue";

const props = defineProps<{ clientName: string; kind: UpstreamKind }>();

const upstreamAuth = ref<UpstreamAuthInfo | null>(null);

async function loadUpstreamAuth() {
  try {
    upstreamAuth.value = await api.get<UpstreamAuthInfo>(clientPath(props.clientName, "upstream-auth"));
  } catch {
    upstreamAuth.value = null;
  }
}
onMounted(loadUpstreamAuth);

const uaEditing = ref(false);
const uaType = ref<"bearer" | "basic" | "header">("bearer");
const uaToken = ref("");
const uaUser = ref("");
const uaPass = ref("");
const uaHeader = ref("");
const uaValue = ref("");
const uaSaving = ref(false);
const uaError = ref("");

async function saveUpstreamAuth() {
  uaError.value = "";
  const body: Record<string, unknown> = { type: uaType.value };
  if (uaType.value === "bearer") body.token = uaToken.value;
  else if (uaType.value === "basic") {
    body.username = uaUser.value;
    body.password = uaPass.value;
  } else {
    body.headerName = uaHeader.value;
    body.value = uaValue.value;
  }
  uaSaving.value = true;
  try {
    await api.put(clientPath(props.clientName, "upstream-auth"), body);
    uaToken.value = uaUser.value = uaPass.value = uaHeader.value = uaValue.value = "";
    uaEditing.value = false;
    await loadUpstreamAuth();
  } catch (err) {
    uaError.value = err instanceof ApiError ? err.message : "Failed to save credentials.";
  } finally {
    uaSaving.value = false;
  }
}

const {
  pending: pendingClearUpstreamAuth,
  request: requestClearUpstreamAuthConfirm,
  cancel: cancelClearUpstreamAuth,
  confirm: confirmClearUpstreamAuthAction,
} = useConfirmAction<true>();

function requestClearUpstreamAuth() {
  requestClearUpstreamAuthConfirm(true);
}

function confirmClearUpstreamAuth() {
  return confirmClearUpstreamAuthAction(async () => {
    try {
      await api.delete(clientPath(props.clientName, "upstream-auth"));
      await loadUpstreamAuth();
    } catch (err) {
      uaError.value = err instanceof ApiError ? err.message : "Failed to clear credentials.";
    }
  });
}
</script>

<template>
  <div class="upstream-auth">
    <div class="ua-head">
      <h2>Upstream authentication</h2>
      <div class="ua-actions">
        <button type="button" class="btn-secondary" @click="uaEditing = !uaEditing">
          {{ uaEditing ? "Cancel" : upstreamAuth?.configured ? "Change" : "Set credentials" }}
        </button>
        <button v-if="upstreamAuth?.configured" type="button" class="link-btn danger" @click="requestClearUpstreamAuth">
          Clear
        </button>
      </div>
    </div>
    <p class="ua-status">
      <template v-if="upstreamAuth?.configured">
        Configured: <code>{{ upstreamAuth.type }}</code
        ><span v-if="upstreamAuth.headerName"> · {{ upstreamAuth.headerName }}</span>
      </template>
      <template v-else>Not configured — requests to this backend are sent without credentials.</template>
      <template v-if="kind !== 'mcp'">
        Alternative to Upstream OAuth below — both can be set at once, but if so the OAuth2 bearer token wins the
        <code>Authorization</code> header on outbound calls.</template
      >
    </p>
    <form v-if="uaEditing" class="ua-form" @submit.prevent="saveUpstreamAuth">
      <label
        >Type
        <select v-model="uaType">
          <option value="bearer">Bearer token</option>
          <option value="basic">Basic (user / password)</option>
          <option value="header">Custom header</option>
        </select>
      </label>
      <label v-if="uaType === 'bearer'">Token <input v-model="uaToken" type="password" autocomplete="off" /></label>
      <template v-else-if="uaType === 'basic'">
        <label>Username <input v-model="uaUser" autocomplete="off" /></label>
        <label>Password <input v-model="uaPass" type="password" autocomplete="off" /></label>
      </template>
      <template v-else>
        <label>Header name <input v-model="uaHeader" placeholder="X-Api-Key" autocomplete="off" /></label>
        <label>Value <input v-model="uaValue" type="password" autocomplete="off" /></label>
      </template>
      <p v-if="uaError" class="error">{{ uaError }}</p>
      <button type="submit" class="btn-primary" :disabled="uaSaving">
        {{ uaSaving ? "Saving…" : "Save credentials" }}
      </button>
    </form>
  </div>

  <ConfirmDialog
    :open="pendingClearUpstreamAuth !== null"
    title="Clear upstream credentials?"
    message="This removes the stored credentials for this backend. This can't be undone — requests will be sent without credentials until you set new ones."
    confirm-label="Clear credentials"
    danger
    @confirm="confirmClearUpstreamAuth"
    @cancel="cancelClearUpstreamAuth"
  />
</template>
