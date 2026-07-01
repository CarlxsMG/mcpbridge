<script setup lang="ts">
import { ref, computed, watch, onMounted } from "vue";
import { useRouter } from "vue-router";
import { api, ApiError } from "../composables/useApi";
import type { BundleDetail, BundleToolRef } from "../types/api";
import ConfirmDialog from "../components/ConfirmDialog.vue";
import BundleToolPicker from "../components/BundleToolPicker.vue";

const props = defineProps<{ name: string }>();
const router = useRouter();

const detail = ref<BundleDetail | null>(null);
const loading = ref(false);
const errorMessage = ref("");

const descriptionInput = ref("");
const savingDescription = ref(false);

const toolsDraft = ref<BundleToolRef[]>([]);
const savingTools = ref(false);
const toolsDirty = computed(() => {
  const current = new Set((detail.value?.tools ?? []).map((t) => `${t.client}__${t.tool}`));
  const draft = new Set(toolsDraft.value.map((t) => `${t.client}__${t.tool}`));
  return current.size !== draft.size || [...current].some((k) => !draft.has(k));
});

const pendingDelete = ref(false);
const deleting = ref(false);

async function load() {
  loading.value = true;
  errorMessage.value = "";
  try {
    detail.value = await api.get<BundleDetail>(`/admin-api/bundles/${encodeURIComponent(props.name)}`);
    descriptionInput.value = detail.value.description ?? "";
    toolsDraft.value = detail.value.tools.map((t) => ({ ...t }));
  } catch (err) {
    errorMessage.value = err instanceof ApiError ? err.message : "Failed to load bundle.";
  } finally {
    loading.value = false;
  }
}
watch(() => props.name, load);
onMounted(load);

const descriptionDirty = computed(() => descriptionInput.value !== (detail.value?.description ?? ""));

async function saveDescription() {
  if (!detail.value) return;
  savingDescription.value = true;
  try {
    await api.patch(`/admin-api/bundles/${encodeURIComponent(props.name)}`, { description: descriptionInput.value || null });
    await load();
  } catch (err) {
    errorMessage.value = err instanceof ApiError ? err.message : "Failed to save description.";
  } finally {
    savingDescription.value = false;
  }
}

async function saveTools() {
  savingTools.value = true;
  try {
    await api.patch(`/admin-api/bundles/${encodeURIComponent(props.name)}`, { tools: toolsDraft.value });
    await load();
  } catch (err) {
    errorMessage.value = err instanceof ApiError ? err.message : "Failed to save tools.";
  } finally {
    savingTools.value = false;
  }
}

async function toggleEnabled() {
  if (!detail.value) return;
  const next = !detail.value.enabled;
  const previous = detail.value.enabled;
  detail.value.enabled = next; // optimistic
  try {
    await api.patch(`/admin-api/bundles/${encodeURIComponent(props.name)}`, { enabled: next });
  } catch (err) {
    detail.value.enabled = previous;
    errorMessage.value = err instanceof ApiError ? err.message : "Failed to update.";
  }
}

function requestDelete() {
  pendingDelete.value = true;
}

async function confirmDelete() {
  pendingDelete.value = false;
  deleting.value = true;
  try {
    await api.delete(`/admin-api/bundles/${encodeURIComponent(props.name)}`);
    router.push("/bundles");
  } catch (err) {
    errorMessage.value = err instanceof ApiError ? err.message : "Failed to delete bundle.";
    deleting.value = false;
  }
}
</script>

<template>
  <section>
    <p class="breadcrumb"><RouterLink to="/bundles">Bundles</RouterLink> / {{ name }}</p>

    <div v-if="loading && !detail" class="loading">Loading…</div>
    <p v-else-if="errorMessage && !detail" class="error" role="alert">{{ errorMessage }}</p>

    <template v-else-if="detail">
      <header class="page-header">
        <div>
          <h1>{{ detail.name }}</h1>
          <p class="endpoint">
            <code>/mcp-custom/{{ detail.name }}</code>
          </p>
        </div>
        <div class="header-actions">
          <button
            type="button"
            class="toggle"
            :class="detail.enabled ? 'toggle-on' : 'toggle-off'"
            :aria-pressed="detail.enabled"
            @click="toggleEnabled"
          >
            {{ detail.enabled ? "Enabled" : "Disabled" }}
          </button>
          <button type="button" class="btn-danger" :disabled="deleting" @click="requestDelete">
            {{ deleting ? "Deleting…" : "Delete bundle" }}
          </button>
        </div>
      </header>

      <p v-if="errorMessage" class="error" role="alert">{{ errorMessage }}</p>

      <div class="field description-field">
        <label for="bundle-description">Description</label>
        <div class="description-row">
          <input id="bundle-description" v-model="descriptionInput" type="text" placeholder="What this bundle is for" />
          <button type="button" class="btn-secondary" :disabled="!descriptionDirty || savingDescription" @click="saveDescription">
            {{ savingDescription ? "Saving…" : "Save" }}
          </button>
        </div>
      </div>

      <h2>Tools ({{ toolsDraft.length }})</h2>
      <BundleToolPicker v-model="toolsDraft" />
      <div class="tools-actions">
        <button type="button" class="btn-primary" :disabled="!toolsDirty || savingTools" @click="saveTools">
          {{ savingTools ? "Saving…" : "Save tools" }}
        </button>
        <span v-if="toolsDirty" class="hint">Unsaved changes to the tool selection.</span>
      </div>
    </template>

    <ConfirmDialog
      :open="pendingDelete"
      title="Delete this bundle?"
      :message="`'${name}' and its /mcp-custom/${name} endpoint will stop working immediately for any connected MCP agent. This cannot be undone.`"
      :confirm-label="`Delete ${name}`"
      danger
      @confirm="confirmDelete"
      @cancel="pendingDelete = false"
    />
  </section>
</template>

<style scoped>
.breadcrumb {
  font-size: 0.85rem;
  color: #63676e;
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
  color: #63676e;
  font-size: 0.85rem;
}
.header-actions {
  display: flex;
  gap: 0.6rem;
  align-items: center;
}
.field label {
  display: block;
  font-size: 0.85rem;
  font-weight: 600;
  margin-bottom: 0.25rem;
}
.description-field {
  margin: 1rem 0 1.5rem;
  max-width: 520px;
}
.description-row {
  display: flex;
  gap: 0.5rem;
}
.description-row input {
  flex: 1;
  padding: 0.45rem 0.6rem;
  border: 1px solid #cfd4da;
  border-radius: 6px;
}
.tools-actions {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  margin-top: 0.75rem;
}
.hint {
  font-size: 0.8rem;
  color: #8a5a00;
}
.toggle {
  display: inline-flex;
  align-items: center;
  gap: 0.4em;
  border-radius: 6px;
  padding: 0.25rem 0.75rem;
  font-size: 0.8rem;
  font-weight: 600;
  cursor: pointer;
  background: #fff;
}
.toggle::before {
  content: "";
  width: 0.6em;
  height: 0.6em;
  border-radius: 50%;
  background: currentColor;
}
.toggle-on {
  border: 1px solid #146c2e;
  color: #146c2e;
}
.toggle-off {
  border: 1px solid #9aa0a8;
  color: #52565c;
}
.loading {
  color: #63676e;
}
.error {
  color: #a11212;
}
</style>
