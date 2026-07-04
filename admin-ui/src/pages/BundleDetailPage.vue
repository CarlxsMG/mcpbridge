<script setup lang="ts">
import { ref, computed, watch, onMounted } from "vue";
import { useRouter, onBeforeRouteLeave } from "vue-router";
import { api, ApiError } from "../composables/useApi";
import { useResource } from "../composables/useResource";
import { useConfirmAction } from "../composables/useConfirmAction";
import { useOptimisticToggle } from "../composables/useOptimisticToggle";
import type { BundleDetail, BundleToolRef } from "../types/api";
import ConfirmDialog from "../components/ConfirmDialog.vue";
import BundleToolPicker from "../components/BundleToolPicker.vue";
import SignalLoader from "../components/SignalLoader.vue";
import TogglePill from "../components/TogglePill.vue";
import ConnectClientDialog from "../components/ConnectClientDialog.vue";
import ShareInstallLinkDialog from "../components/ShareInstallLinkDialog.vue";
import FormField from "../components/FormField.vue";
import { Cable, Share2 } from "lucide-vue-next";

const props = defineProps<{ name: string }>();
const router = useRouter();

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
const descriptionError = ref("");
const toolsError = ref("");
const deleteError = ref("");

const descriptionInput = ref("");
const savingDescription = ref(false);

const toolsDraft = ref<BundleToolRef[]>([]);
const savingTools = ref(false);
const toolsDirty = computed(() => {
  const current = new Set((detail.value?.tools ?? []).map((t) => `${t.client}__${t.tool}`));
  const draft = new Set(toolsDraft.value.map((t) => `${t.client}__${t.tool}`));
  return current.size !== draft.size || [...current].some((k) => !draft.has(k));
});

const {
  pending: pendingDelete,
  request: requestDeleteConfirm,
  cancel: cancelDelete,
  confirm: confirmDeleteAction,
} = useConfirmAction<true>();
const deleting = ref(false);
const connectOpen = ref(false);
const shareOpen = ref(false);

const { rowError: toggleError, toggle } = useOptimisticToggle<BundleDetail>(() => "singleton", "Failed to update bundle.");

async function load() {
  const result = await loadDetail();
  if (result) {
    descriptionInput.value = result.description ?? "";
    toolsDraft.value = result.tools.map((t) => ({ ...t }));
  }
}
watch(() => props.name, load);
onMounted(load);

const descriptionDirty = computed(() => descriptionInput.value !== (detail.value?.description ?? ""));

async function saveDescription() {
  if (!detail.value) return;
  descriptionError.value = "";
  savingDescription.value = true;
  try {
    await api.patch(`/admin-api/bundles/${encodeURIComponent(props.name)}`, {
      description: descriptionInput.value || null,
    });
    await load();
  } catch (err) {
    descriptionError.value = err instanceof ApiError ? err.message : "Failed to save description.";
  } finally {
    savingDescription.value = false;
  }
}

async function saveTools() {
  toolsError.value = "";
  savingTools.value = true;
  try {
    await api.patch(`/admin-api/bundles/${encodeURIComponent(props.name)}`, { tools: toolsDraft.value });
    await load();
  } catch (err) {
    toolsError.value = err instanceof ApiError ? err.message : "Failed to save tools.";
  } finally {
    savingTools.value = false;
  }
}

async function toggleEnabled() {
  if (!detail.value) return;
  await toggle(detail.value, "enabled", (next) =>
    api.patch(`/admin-api/bundles/${encodeURIComponent(props.name)}`, { enabled: next }),
  );
  errorMessage.value = toggleError.value.singleton ?? "";
}

function requestDelete() {
  requestDeleteConfirm(true);
}

const deleted = ref(false);

function confirmDelete() {
  return confirmDeleteAction(async () => {
    deleteError.value = "";
    deleting.value = true;
    try {
      await api.delete(`/admin-api/bundles/${encodeURIComponent(props.name)}`);
      deleted.value = true;
      router.push("/bundles");
    } catch (err) {
      deleteError.value = err instanceof ApiError ? err.message : "Failed to delete bundle.";
      deleting.value = false;
    }
  });
}

const pendingLeave = ref(false);
let leaveNext: ((valid?: boolean) => void) | null = null;

onBeforeRouteLeave((_to, _from, next) => {
  if (!deleted.value && (descriptionDirty.value || toolsDirty.value)) {
    leaveNext = next;
    pendingLeave.value = true;
  } else {
    next();
  }
});

function confirmLeave() {
  pendingLeave.value = false;
  leaveNext?.(true);
  leaveNext = null;
}

function cancelLeave() {
  pendingLeave.value = false;
  leaveNext?.(false);
  leaveNext = null;
}
</script>

<template>
  <section>
    <p class="breadcrumb"><RouterLink to="/bundles">Bundles</RouterLink> / {{ name }}</p>

    <SignalLoader v-if="loading && !detail" />
    <p v-else-if="errorMessage && !detail" class="error" role="alert">{{ errorMessage }}</p>

    <template v-else-if="detail">
      <header class="page-header">
        <div>
          <h1>{{ detail.name }}</h1>
          <p class="endpoint">
            <code>/mcp-custom/{{ detail.name }}</code>
            <button type="button" class="link-btn connect-link" @click="connectOpen = true">
              <Cable :size="13" stroke-width="2" aria-hidden="true" /> Connect client
            </button>
          </p>
        </div>
        <div class="header-actions">
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
        </div>
      </header>

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
.page-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  margin-bottom: 1rem;
}
.page-header h1 {
  margin: 0 0 0.3rem;
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
.header-actions {
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
.row-error {
  color: var(--breach);
  font-size: 0.75rem;
  margin: 0.25rem 0 0;
}
.error {
  color: var(--breach);
}
</style>
