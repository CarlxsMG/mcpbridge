<script setup lang="ts">
import { ref, onMounted } from "vue";
import { api } from "@/composables/useApi";
import { clientPath } from "@/utils/apiPaths";
import { useConfirmAction } from "@/composables/useConfirmAction";
import { useResource } from "@/composables/useResource";
import { usePatchResource } from "@/composables/usePatchResource";
import { toErrorMessage } from "@/utils/errors";
import type { UpstreamAuthInfo, UpstreamKind } from "@/types/api";
import ConfirmDialog from "@/components/ui/ConfirmDialog.vue";
import ConfigSection from "./ConfigSection.vue";
import SelectMenu from "@/components/ui/SelectMenu.vue";

const props = defineProps<{ clientName: string; kind: UpstreamKind }>();

const TYPE_OPTIONS: { value: "bearer" | "basic" | "header"; label: string }[] = [
  { value: "bearer", label: "Bearer token" },
  { value: "basic", label: "Basic (user / password)" },
  { value: "header", label: "Custom header" },
];

const { data: upstreamAuth, load: loadUpstreamAuth } = useResource<UpstreamAuthInfo | null>(
  () => api.get<UpstreamAuthInfo>(clientPath(props.clientName, "upstream-auth")),
  null,
);
onMounted(loadUpstreamAuth);

const uaEditing = ref(false);
const uaType = ref<"bearer" | "basic" | "header">("bearer");
const uaToken = ref("");
const uaUser = ref("");
const uaPass = ref("");
const uaHeader = ref("");
const uaValue = ref("");

const {
  saving: uaSaving,
  error: uaError,
  run: runUpstreamAuth,
} = usePatchResource(() => clientPath(props.clientName, "upstream-auth"));

async function saveUpstreamAuth() {
  const body: Record<string, unknown> = { type: uaType.value };
  if (uaType.value === "bearer") body.token = uaToken.value;
  else if (uaType.value === "basic") {
    body.username = uaUser.value;
    body.password = uaPass.value;
  } else {
    body.headerName = uaHeader.value;
    body.value = uaValue.value;
  }
  const ok = await runUpstreamAuth((path) => api.put(path, body), "Failed to save credentials.");
  if (ok) {
    uaToken.value = uaUser.value = uaPass.value = uaHeader.value = uaValue.value = "";
    uaEditing.value = false;
    await loadUpstreamAuth();
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
      uaError.value = toErrorMessage(err, "Failed to clear credentials.");
    }
  });
}
</script>

<template>
  <ConfigSection title="Upstream authentication">
    <template #actions>
      <button type="button" class="btn-secondary" @click="uaEditing = !uaEditing">
        {{ uaEditing ? "Cancel" : upstreamAuth?.configured ? "Change" : "Set credentials" }}
      </button>
      <button v-if="upstreamAuth?.configured" type="button" class="link-btn danger" @click="requestClearUpstreamAuth">
        Clear
      </button>
    </template>
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
        <SelectMenu v-model="uaType" :options="TYPE_OPTIONS" />
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
  </ConfigSection>

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
