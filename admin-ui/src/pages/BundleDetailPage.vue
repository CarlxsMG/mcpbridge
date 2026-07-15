<script setup lang="ts">
import { ref, watch, onMounted } from "vue";
import { useI18n } from "vue-i18n";
import { api } from "@/composables/useApi";
import { useResource } from "@/composables/useResource";
import { useOptimisticToggle } from "@/composables/useOptimisticToggle";
import { useUnsavedChangesGuard } from "@/composables/useUnsavedChangesGuard";
import { useFieldDraft } from "@/composables/useFieldDraft";
import { useDetailPageDelete, syncAfterLoad } from "@/composables/useDetailPageDelete";
import { bundlePath } from "@/utils/apiPaths";
import { tk } from "@/i18n";
import type { BundleDetail, BundleToolRef } from "@/types/api";
import ConfirmDialog from "@/components/ui/ConfirmDialog.vue";
import BundleToolPicker from "@/components/BundleToolPicker.vue";
import SignalLoader from "@/components/ui/SignalLoader.vue";
import PageHeader from "@/components/ui/PageHeader.vue";
import TogglePill from "@/components/ui/TogglePill.vue";
import ConnectClientDialog from "@/components/ConnectClientDialog.vue";
import ShareInstallLinkDialog from "@/components/ShareInstallLinkDialog.vue";
import FormField from "@/components/ui/FormField.vue";
import { Cable, Share2 } from "lucide-vue-next";

const props = defineProps<{ name: string }>();
const { t } = useI18n({ useScope: "global" });

const {
  data: detail,
  loading,
  errorMessage,
  load: loadDetail,
} = useResource<BundleDetail | null>(
  () => api.get<BundleDetail>(bundlePath(props.name)),
  null,
  tk("pages.bundle_detail.errors.load_failed"),
);

const {
  draft: descriptionInput,
  dirty: descriptionDirty,
  saving: savingDescription,
  errorMessage: descriptionError,
  sync: syncDescription,
  commit: saveDescription,
} = useFieldDraft(
  () => detail.value?.description ?? "",
  async (value) => {
    await api.patch(bundlePath(props.name), { description: value || null });
    await load();
  },
  { fallbackMessage: tk("pages.bundle_detail.errors.save_description_failed") },
);

const {
  draft: toolsDraft,
  dirty: toolsDirty,
  saving: savingTools,
  errorMessage: toolsError,
  sync: syncTools,
  commit: saveTools,
} = useFieldDraft<BundleToolRef[]>(
  () => detail.value?.tools ?? [],
  async (value) => {
    await api.patch(bundlePath(props.name), { tools: value });
    await load();
  },
  {
    fallbackMessage: tk("pages.bundle_detail.errors.save_tools_failed"),
    isEqual: (a, b) => {
      const setA = new Set(a.map((tt) => `${tt.client}__${tt.tool}`));
      const setB = new Set(b.map((tt) => `${tt.client}__${tt.tool}`));
      return setA.size === setB.size && [...setA].every((k) => setB.has(k));
    },
  },
);

const {
  pendingDelete,
  requestDelete,
  cancelDelete,
  confirmDelete,
  deleting,
  deleted,
  error: deleteError,
} = useDetailPageDelete(() => bundlePath(props.name), "/bundles", tk("pages.bundle_detail.errors.delete_failed"));
const connectOpen = ref(false);
const shareOpen = ref(false);

const { rowError: toggleError, toggle } = useOptimisticToggle<BundleDetail>(
  () => "singleton",
  tk("pages.bundle_detail.errors.toggle_failed"),
);

async function load() {
  await syncAfterLoad(loadDetail, syncDescription, syncTools);
}
watch(() => props.name, load);
onMounted(load);

async function toggleEnabled() {
  if (!detail.value) return;
  await toggle(detail.value, "enabled", (next) => api.patch(bundlePath(props.name), { enabled: next }));
  errorMessage.value = toggleError.value.singleton ?? "";
}

const { pendingLeave, confirmLeave, cancelLeave } = useUnsavedChangesGuard(
  () => descriptionDirty.value || toolsDirty.value,
  () => deleted.value,
);
</script>

<template>
  <section>
    <p class="breadcrumb">
      <RouterLink to="/bundles">{{ t("nav.bundles.label") }}</RouterLink> / {{ name }}
    </p>

    <SignalLoader v-if="loading && !detail" />
    <p v-else-if="errorMessage && !detail" class="error" role="alert">{{ errorMessage }}</p>

    <template v-else-if="detail">
      <PageHeader :title="detail.name">
        <template #meta>
          <p class="endpoint">
            <code>/mcp-custom/{{ detail.name }}</code>
            <button type="button" class="link-btn connect-link" @click="connectOpen = true">
              <Cable :size="13" stroke-width="2" aria-hidden="true" /> {{ t("common.connect_client") }}
            </button>
          </p>
        </template>
        <TogglePill
          :on="detail.enabled"
          :on-label="t('pages.bundle_detail.disable_bundle')"
          :off-label="t('pages.bundle_detail.enable_bundle')"
          @click="toggleEnabled"
        />
        <button type="button" class="btn-secondary share-btn" @click="shareOpen = true">
          <Share2 :size="14" stroke-width="2" aria-hidden="true" /> {{ t("pages.bundle_detail.share_link") }}
        </button>
        <button type="button" class="btn-danger" :disabled="deleting" @click="requestDelete">
          {{ deleting ? t("pages.bundle_detail.deleting") : t("pages.bundle_detail.delete_bundle") }}
        </button>
      </PageHeader>

      <p v-if="errorMessage" class="error" role="alert">{{ errorMessage }}</p>
      <p v-if="deleteError" class="row-error" role="alert">{{ deleteError }}</p>

      <FormField :label="t('pages.bundle_detail.description_label')" for="bundle-description" class="description-field">
        <div class="description-row">
          <input
            id="bundle-description"
            v-model="descriptionInput"
            type="text"
            :placeholder="t('pages.bundle_detail.description_placeholder')"
          />
          <button
            type="button"
            class="btn-secondary"
            :disabled="!descriptionDirty || savingDescription"
            @click="saveDescription"
          >
            {{ savingDescription ? t("common.saving") : t("common.save") }}
          </button>
        </div>
        <p v-if="descriptionError" class="row-error" role="alert">{{ descriptionError }}</p>
      </FormField>

      <h2>{{ t("pages.bundle_detail.tools_heading", { count: toolsDraft.length }) }}</h2>
      <BundleToolPicker v-model="toolsDraft" />
      <div class="tools-actions">
        <button type="button" class="btn-primary" :disabled="!toolsDirty || savingTools" @click="saveTools">
          {{ savingTools ? t("common.saving") : t("pages.bundle_detail.save_tools") }}
        </button>
        <span v-if="toolsDirty" class="hint">{{ t("pages.bundle_detail.unsaved_tools") }}</span>
      </div>
      <p v-if="toolsError" class="row-error" role="alert">{{ toolsError }}</p>
    </template>

    <ConfirmDialog
      :open="pendingDelete !== null"
      :title="t('pages.bundle_detail.confirm.delete_title')"
      :message="t('pages.bundle_detail.confirm.delete_message', { name })"
      :confirm-label="t('pages.bundle_detail.confirm.delete_cta', { name })"
      danger
      @confirm="confirmDelete"
      @cancel="cancelDelete"
    />

    <ConfirmDialog
      :open="pendingLeave"
      :title="t('pages.bundle_detail.confirm.leave_title')"
      :message="t('pages.bundle_detail.confirm.leave_message')"
      :confirm-label="t('pages.bundle_detail.confirm.leave_cta')"
      danger
      @confirm="confirmLeave"
      @cancel="cancelLeave"
    />

    <ConnectClientDialog :open="connectOpen" preset-scope="bundle" :preset-name="name" @close="connectOpen = false" />
    <ShareInstallLinkDialog :open="shareOpen" :bundle-name="name" @close="shareOpen = false" />
  </section>
</template>

<style scoped>
.breadcrumb {
  font-size: 0.85rem;
  color: var(--text-secondary);
}
.endpoint {
  margin: 0;
  color: var(--text-secondary);
  font-size: 0.85rem;
  display: flex;
  align-items: center;
  gap: 0.6rem;
}
.connect-link {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
}
.share-btn {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
}
:deep(.header-actions) {
  display: flex;
  gap: 0.6rem;
  align-items: center;
  flex: 1;
}
.header-actions .btn-danger {
  margin-left: auto;
}
.description-field {
  margin: 1rem 0 1.5rem;
  max-width: 32.5rem;
}
.description-row {
  display: flex;
  gap: 0.5rem;
}
.description-row input {
  flex: 1;
  padding: 0.55rem 0.7rem;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  font-size: 0.9rem;
  font-family: var(--font-body);
  box-sizing: border-box;
}
.tools-actions {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  margin-top: 0.75rem;
}
.hint {
  font-size: 0.8rem;
  color: var(--canary);
}
</style>
