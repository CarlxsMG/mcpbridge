<script setup lang="ts">
import { ref, computed, watch, onMounted } from "vue";
import { useRouter, onBeforeRouteLeave } from "vue-router";
import { api, ApiError } from "../composables/useApi";
import { useResource } from "../composables/useResource";
import type { CompositeDetail, CompositeStep } from "../types/api";
import ConfirmDialog from "../components/ConfirmDialog.vue";

const props = defineProps<{ name: string }>();
const router = useRouter();

const {
  data: detail,
  loading,
  errorMessage,
  load: loadDetail,
} = useResource<CompositeDetail | null>(
  () => api.get<CompositeDetail>(`/admin-api/composites/${encodeURIComponent(props.name)}`),
  null,
  "Failed to load composite.",
);

const descriptionInput = ref("");
const savingDescription = ref(false);

const schemaInput = ref("");
const schemaError = ref("");
const savingSchema = ref(false);

const stepsInput = ref("");
const stepsError = ref("");
const savingSteps = ref(false);

const pendingDelete = ref(false);
const deleting = ref(false);
const deleted = ref(false);

async function load() {
  const result = await loadDetail();
  if (result) {
    descriptionInput.value = result.description ?? "";
    schemaInput.value = JSON.stringify(result.inputSchema, null, 2);
    stepsInput.value = JSON.stringify(result.steps, null, 2);
  }
}
watch(() => props.name, load);
onMounted(load);

const descriptionDirty = computed(() => descriptionInput.value !== (detail.value?.description ?? ""));
const schemaDirty = computed(() => schemaInput.value !== JSON.stringify(detail.value?.inputSchema ?? {}, null, 2));
const stepsDirty = computed(() => stepsInput.value !== JSON.stringify(detail.value?.steps ?? [], null, 2));
const isDirty = computed(() => descriptionDirty.value || schemaDirty.value || stepsDirty.value);

const pendingLeave = ref(false);
let leaveNext: ((valid?: boolean) => void) | null = null;

onBeforeRouteLeave((_to, _from, next) => {
  if (!deleted.value && isDirty.value) {
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

async function saveDescription() {
  if (!detail.value) return;
  savingDescription.value = true;
  try {
    await api.patch(`/admin-api/composites/${encodeURIComponent(props.name)}`, {
      description: descriptionInput.value || null,
    });
    await load();
  } catch (err) {
    errorMessage.value = err instanceof ApiError ? err.message : "Failed to save description.";
  } finally {
    savingDescription.value = false;
  }
}

async function saveSchema() {
  schemaError.value = "";
  let inputSchema: Record<string, unknown>;
  try {
    inputSchema = JSON.parse(schemaInput.value) as Record<string, unknown>;
  } catch {
    schemaError.value = "inputSchema is not valid JSON.";
    return;
  }
  savingSchema.value = true;
  try {
    await api.patch(`/admin-api/composites/${encodeURIComponent(props.name)}`, { inputSchema });
    await load();
  } catch (err) {
    schemaError.value = err instanceof ApiError ? err.message : "Failed to save input schema.";
  } finally {
    savingSchema.value = false;
  }
}

async function saveSteps() {
  stepsError.value = "";
  let steps: CompositeStep[];
  try {
    steps = JSON.parse(stepsInput.value) as CompositeStep[];
  } catch {
    stepsError.value = "steps is not valid JSON.";
    return;
  }
  savingSteps.value = true;
  try {
    await api.patch(`/admin-api/composites/${encodeURIComponent(props.name)}`, { steps });
    await load();
  } catch (err) {
    stepsError.value = err instanceof ApiError ? err.message : "Failed to save steps.";
  } finally {
    savingSteps.value = false;
  }
}

async function toggleEnabled() {
  if (!detail.value) return;
  const next = !detail.value.enabled;
  const previous = detail.value.enabled;
  detail.value.enabled = next; // optimistic
  try {
    await api.patch(`/admin-api/composites/${encodeURIComponent(props.name)}`, { enabled: next });
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
    await api.delete(`/admin-api/composites/${encodeURIComponent(props.name)}`);
    deleted.value = true;
    router.push("/composites");
  } catch (err) {
    errorMessage.value = err instanceof ApiError ? err.message : "Failed to delete composite.";
    deleting.value = false;
  }
}
</script>

<template>
  <section>
    <p class="breadcrumb"><RouterLink to="/composites">Composites</RouterLink> / {{ name }}</p>

    <div v-if="loading && !detail" class="loading">Loading…</div>
    <p v-else-if="errorMessage && !detail" class="error" role="alert">{{ errorMessage }}</p>

    <template v-else-if="detail">
      <header class="page-header">
        <div>
          <h1>{{ detail.name }}</h1>
        </div>
        <div class="header-actions">
          <button
            type="button"
            class="toggle"
            :class="detail.enabled ? 'toggle-on' : 'toggle-off'"
            :aria-pressed="detail.enabled"
            @click="toggleEnabled"
          >
            {{ detail.enabled ? "Disable composite" : "Enable composite" }}
          </button>
          <button type="button" class="btn-danger" :disabled="deleting" @click="requestDelete">
            {{ deleting ? "Deleting…" : "Delete composite" }}
          </button>
        </div>
      </header>

      <p v-if="errorMessage" class="error" role="alert">{{ errorMessage }}</p>

      <div class="field description-field">
        <label for="composite-description">Description</label>
        <div class="description-row">
          <input
            id="composite-description"
            v-model="descriptionInput"
            type="text"
            placeholder="What this composite does"
          />
          <button
            type="button"
            class="btn-secondary"
            :disabled="!descriptionDirty || savingDescription"
            @click="saveDescription"
          >
            {{ savingDescription ? "Saving…" : "Save" }}
          </button>
        </div>
      </div>

      <div class="field json-field">
        <label for="composite-schema">Input schema (JSON)</label>
        <textarea id="composite-schema" v-model="schemaInput" rows="8" spellcheck="false"></textarea>
        <div class="field-actions">
          <button type="button" class="btn-primary" :disabled="!schemaDirty || savingSchema" @click="saveSchema">
            {{ savingSchema ? "Saving…" : "Save schema" }}
          </button>
        </div>
        <p v-if="schemaError" class="error">{{ schemaError }}</p>
      </div>

      <div class="field json-field">
        <label for="composite-steps">Steps (JSON array)</label>
        <p class="template-hint">
          Templates: <code>{{ '{ "$ref": "steps.0.json.id" }' }}</code> or <code>{{ '"${input.name}"' }}</code
          >.
        </p>
        <textarea id="composite-steps" v-model="stepsInput" rows="10" spellcheck="false"></textarea>
        <div class="field-actions">
          <button type="button" class="btn-primary" :disabled="!stepsDirty || savingSteps" @click="saveSteps">
            {{ savingSteps ? "Saving…" : "Save steps" }}
          </button>
        </div>
        <p v-if="stepsError" class="error">{{ stepsError }}</p>
      </div>
    </template>

    <ConfirmDialog
      :open="pendingDelete"
      title="Delete this composite?"
      :message="`MCP clients calling '${name}' will start failing immediately. This cannot be undone.`"
      :confirm-label="`Delete ${name}`"
      danger
      @confirm="confirmDelete"
      @cancel="pendingDelete = false"
    />

    <ConfirmDialog
      :open="pendingLeave"
      title="Discard unsaved changes?"
      message="You have unsaved changes to the description, input schema, or steps for this composite. Leaving now will discard them."
      confirm-label="Discard changes"
      danger
      @confirm="confirmLeave"
      @cancel="cancelLeave"
    />
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
  padding: 0.55rem 0.7rem;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  font-size: 0.9rem;
  font-family: var(--font-body);
}
.json-field {
  margin: 0 0 1.5rem;
}
.json-field textarea {
  width: 100%;
  box-sizing: border-box;
  font-family: var(--font-mono);
  font-size: 0.85rem;
  padding: 0.6rem 0.7rem;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
}
.template-hint {
  color: var(--text-secondary);
  font-size: 0.82rem;
  margin: 0 0 0.4rem;
}
.field-actions {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  margin-top: 0.5rem;
}
.toggle {
  display: inline-flex;
  align-items: center;
  gap: 0.45em;
  border-radius: var(--radius-pill);
  padding: 0.28rem 0.8rem;
  font-size: 0.78rem;
  font-weight: 600;
  cursor: pointer;
  background: var(--surface);
  transition: background-color 0.12s ease;
}
.toggle::before {
  content: "";
  width: 0.55em;
  height: 0.55em;
  border-radius: 50%;
  background: currentColor;
  flex-shrink: 0;
}
.toggle-on {
  border: 1px solid var(--ok);
  color: var(--ok);
}
.toggle-off {
  border: 1px solid var(--border-strong);
  color: var(--text-secondary);
}
.toggle-on:hover {
  background: var(--ok-soft);
}
.toggle-off:hover {
  background: var(--surface-sunken);
}
.loading {
  color: var(--text-secondary);
}
</style>
