<script setup lang="ts">
import { ref, watch, onMounted } from "vue";
import { api } from "@/composables/useApi";
import { useResource } from "@/composables/useResource";
import { useOptimisticToggle } from "@/composables/useOptimisticToggle";
import { useUnsavedChangesGuard } from "@/composables/useUnsavedChangesGuard";
import { useFieldDraft } from "@/composables/useFieldDraft";
import { useDetailPageDelete, syncAfterLoad } from "@/composables/useDetailPageDelete";
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

const {
  data: detail,
  loading,
  errorMessage,
  load: loadDetail,
} = useResource<BundleDetail | null>(
  () => api.get<BundleDetail>(`/admin-api/bundles/${encodeURIComponent(props.name)}`),
  null,
  "Failed to load bundle.",
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
    await api.patch(`/admin-api/bundles/${encodeURIComponent(props.name)}`, { description: value || null });
    await load();
  },
  { fallbackMessage: "Failed to save description." },
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
    await api.patch(`/admin-api/bundles/${encodeURIComponent(props.name)}`, { tools: value });
    await load();
  },
  {
    fallbackMessage: "Failed to save tools.",
    isEqual: (a, b) => {
      const setA = new Set(a.map((t) => `${t.client}__${t.tool}`));
      const setB = new Set(b.map((t) => `${t.client}__${t.tool}`));
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
} = useDetailPageDelete(
  () => `/admin-api/bundles/${encodeURIComponent(props.name)}`,
  "/bundles",
  "Failed to delete bundle.",
);
const connectOpen = ref(false);
const shareOpen = ref(false);

const { rowError: toggleError, toggle } = useOptimisticToggle<BundleDetail>(
  () => "singleton",
  "Failed to update bundle.",
);

async function load() {
  await syncAfterLoad(loadDetail, syncDescription, syncTools);
}
watch(() => props.name, load);
onMounted(load);

async function toggleEnabled() {
  if (!detail.value) return;
  await toggle(detail.value, "enabled", (next) =>
    api.patch(`/admin-api/bundles/${encodeURIComponent(props.name)}`, { enabled: next }),
  );
  errorMessage.value = toggleError.value.singleton ?? "";
}

const { pendingLeave, confirmLeave, cancelLeave } = useUnsavedChangesGuard(
  () => descriptionDirty.value || toolsDirty.value,
  () => deleted.value,
);
</script>

<template>
  <section>
    <p class="breadcrumb"><RouterLink to="/bundles">Bundles</RouterLink> / {{ name }}</p>

    <SignalLoader v-if="loading && !detail" />
    <p v-else-if="errorMessage && !detail" class="error" role="alert">{{ errorMessage }}</p>

    <template v-else-if="detail">
      <PageHeader :title="detail.name">
        <template #meta>
          <p class="endpoint">
            <code>/mcp-custom/{{ detail.name }}</code>
            <button type="button" class="link-btn connect-link" @click="connectOpen = true">
              <Cable :size="13" stroke-width="2" aria-hidden="true" /> Connect client
            </button>
          </p>
        </template>
        <TogglePill
          :on="detail.enabled"
          on-label="Disable bundle"
          off-label="Enable bundle"
          :aria-pressed="detail.enabled"
          @click="toggleEnabled"
        />
        <button type="button" class="btn-secondary share-btn" @click="shareOpen = true">
          <Share2 :size="14" stroke-width="2" aria-hidden="true" /> Share install link
        </button>
        <button type="button" class="btn-danger" :disabled="deleting" @click="requestDelete">
          {{ deleting ? "Deleting…" : "Delete bundle" }}
        </button>
      </PageHeader>

      <p v-if="errorMessage" class="error" role="alert">{{ errorMessage }}</p>
      <p v-if="deleteError" class="row-error">{{ deleteError }}</p>

      <FormField label="Description" for="bundle-description" class="description-field">
        <div class="description-row">
          <input id="bundle-description" v-model="descriptionInput" type="text" placeholder="What this bundle is for" />
          <button
            type="button"
            class="btn-secondary"
            :disabled="!descriptionDirty || savingDescription"
            @click="saveDescription"
          >
            {{ savingDescription ? "Saving…" : "Save" }}
          </button>
        </div>
        <p v-if="descriptionError" class="row-error">{{ descriptionError }}</p>
      </FormField>

      <h2>Tools ({{ toolsDraft.length }})</h2>
      <BundleToolPicker v-model="toolsDraft" />
      <div class="tools-actions">
        <button type="button" class="btn-primary" :disabled="!toolsDirty || savingTools" @click="saveTools">
          {{ savingTools ? "Saving…" : "Save tools" }}
        </button>
        <span v-if="toolsDirty" class="hint">Unsaved changes to the tool selection.</span>
      </div>
      <p v-if="toolsError" class="row-error">{{ toolsError }}</p>
    </template>

    <ConfirmDialog
      :open="pendingDelete !== null"
      title="Delete this bundle?"
      :message="`'${name}' and its /mcp-custom/${name} endpoint will stop working immediately for any connected MCP agent. This cannot be undone.`"
      :confirm-label="`Delete ${name}`"
      danger
      @confirm="confirmDelete"
      @cancel="cancelDelete"
    />

    <ConfirmDialog
      :open="pendingLeave"
      title="Discard unsaved changes?"
      message="You have unsaved changes to the description or tool selection for this bundle. Leaving now will discard them."
      confirm-label="Discard changes"
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
/* PageHeader's own recipe covers the title; this page still needs its three
   header actions (toggle pill, share button, delete button) laid out in a row
   (PageHeader's .header-actions wrapper is rendered by the child component,
   so reaching it requires :deep()). */
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
