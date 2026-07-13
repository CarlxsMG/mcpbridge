<script setup lang="ts">
import { ref, onMounted } from "vue";
import { useI18n } from "vue-i18n";
import { api } from "@/composables/useApi";
import { clientPath } from "@/utils/apiPaths";
import { useClearableConfig } from "@/composables/useClearableConfig";
import { useResource } from "@/composables/useResource";
import { usePatchResource } from "@/composables/usePatchResource";
import { tk } from "@/i18n";
import type { UpstreamAuthInfo, UpstreamKind } from "@/types/api";
import ConfirmDialog from "@/components/ui/ConfirmDialog.vue";
import ConfigSection from "./ConfigSection.vue";
import SelectMenu from "@/components/ui/SelectMenu.vue";
import FieldError from "@/components/ui/FieldError.vue";

const props = defineProps<{ clientName: string; kind: UpstreamKind }>();
const { t } = useI18n({ useScope: "global" });

const TYPE_OPTIONS: { value: "bearer" | "basic" | "header"; label: string }[] = [
  { value: "bearer", label: t("components.server_detail_upstream_auth.types.bearer") },
  { value: "basic", label: t("components.server_detail_upstream_auth.types.basic") },
  { value: "header", label: t("components.server_detail_upstream_auth.types.header") },
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
  const ok = await runUpstreamAuth(
    (path) => api.put(path, body),
    tk("components.server_detail_upstream_auth.errors.save_failed"),
  );
  if (ok) {
    uaToken.value = uaUser.value = uaPass.value = uaHeader.value = uaValue.value = "";
    uaEditing.value = false;
    await loadUpstreamAuth();
  }
}

const {
  pendingClear: pendingClearUpstreamAuth,
  requestClear: requestClearUpstreamAuth,
  cancelClear: cancelClearUpstreamAuth,
  confirmClear: confirmClearUpstreamAuth,
  error: clearUaError,
} = useClearableConfig(
  loadUpstreamAuth,
  () => api.delete(clientPath(props.clientName, "upstream-auth")),
  tk("components.server_detail_upstream_auth.errors.clear_failed"),
);
</script>

<template>
  <ConfigSection :title="t('components.server_detail_upstream_auth.title')">
    <template #actions>
      <button type="button" class="btn-secondary" @click="uaEditing = !uaEditing">
        {{
          uaEditing
            ? t("common.cancel")
            : upstreamAuth?.configured
              ? t("components.server_detail_upstream_auth.change")
              : t("components.server_detail_upstream_auth.set_credentials")
        }}
      </button>
      <button v-if="upstreamAuth?.configured" type="button" class="link-btn danger" @click="requestClearUpstreamAuth">
        {{ t("components.server_detail_upstream_auth.clear") }}
      </button>
    </template>
    <p class="ua-status">
      <template v-if="upstreamAuth?.configured">
        {{ t("components.server_detail_upstream_auth.configured") }}: <code>{{ upstreamAuth.type }}</code
        ><span v-if="upstreamAuth.headerName"> · {{ upstreamAuth.headerName }}</span>
      </template>
      <template v-else>{{ t("components.server_detail_upstream_auth.not_configured") }}</template>
      <template v-if="kind !== 'mcp'">{{ t("components.server_detail_upstream_auth.oauth_note") }}</template>
    </p>
    <form v-if="uaEditing" class="ua-form" @submit.prevent="saveUpstreamAuth">
      <label
        >{{ t("components.server_detail_upstream_auth.fields.type") }}
        <SelectMenu v-model="uaType" :options="TYPE_OPTIONS" />
      </label>
      <label v-if="uaType === 'bearer'"
        >{{ t("components.server_detail_upstream_auth.fields.token") }}
        <input v-model="uaToken" type="password" autocomplete="off"
      /></label>
      <template v-else-if="uaType === 'basic'">
        <label
          >{{ t("components.server_detail_upstream_auth.fields.username") }} <input v-model="uaUser" autocomplete="off"
        /></label>
        <label
          >{{ t("components.server_detail_upstream_auth.fields.password") }}
          <input v-model="uaPass" type="password" autocomplete="off"
        /></label>
      </template>
      <template v-else>
        <label
          >{{ t("components.server_detail_upstream_auth.fields.header_name") }}
          <input v-model="uaHeader" placeholder="X-Api-Key" autocomplete="off"
        /></label>
        <label
          >{{ t("components.server_detail_upstream_auth.fields.value") }}
          <input v-model="uaValue" type="password" autocomplete="off"
        /></label>
      </template>
      <FieldError :message="uaError || clearUaError" />
      <button type="submit" class="btn-primary" :disabled="uaSaving">
        {{ uaSaving ? t("common.saving") : t("components.server_detail_upstream_auth.save_credentials") }}
      </button>
    </form>
  </ConfigSection>

  <ConfirmDialog
    :open="pendingClearUpstreamAuth !== null"
    :title="t('components.server_detail_upstream_auth.confirm.clear_title')"
    :message="t('components.server_detail_upstream_auth.confirm.clear_message')"
    :confirm-label="t('components.server_detail_upstream_auth.confirm.clear_cta')"
    danger
    @confirm="confirmClearUpstreamAuth"
    @cancel="cancelClearUpstreamAuth"
  />
</template>
