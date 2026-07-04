<script setup lang="ts">
import { ref, computed, watch, onMounted } from "vue";
import { useRouter, onBeforeRouteLeave } from "vue-router";
import { api, ApiError } from "../composables/useApi";
import { useResource } from "../composables/useResource";
import { useConfirmAction } from "../composables/useConfirmAction";
import { useOptimisticToggle } from "../composables/useOptimisticToggle";
import type { CompositeDetail, CompositeStep } from "../types/api";
import ConfirmDialog from "../components/ConfirmDialog.vue";
import SignalLoader from "../components/SignalLoader.vue";
import PageHeader from "../components/PageHeader.vue";
import FormField from "../components/FormField.vue";
import TogglePill from "../components/TogglePill.vue";

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

const {
  pending: pendingDelete,
  request: requestPendingDelete,
  cancel: cancelDelete,
  confirm: confirmPendingDelete,
} = useConfirmAction<true>();
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

const { rowError: toggleError, toggle: toggleEnabledField } = useOptimisticToggle<CompositeDetail>(
  (c) => c.name,
  "Failed to update.",
);

function toggleEnabled() {
  if (!detail.value) return;
  toggleEnabledField(detail.value, "enabled", (next) =>
    api.patch(`/admin-api/composites/${encodeURIComponent(props.name)}`, { enabled: next }),
  );
}

function requestDelete() {
  requestPendingDelete(true);
}

async function confirmDelete() {
  await confirmPendingDelete(async () => {
    deleting.value = true;
    try {
      await api.delete(`/admin-api/composites/${encodeURIComponent(props.name)}`);
      deleted.value = true;
      router.push("/composites");
    } catch (err) {
      errorMessage.value = err instanceof ApiError ? err.message : "Failed to delete composite.";
      deleting.value = false;
    }
  });
}
</script>

<template>
  <section>
    <p class="breadcrumb"><RouterLink to="/composites">Composites</RouterLink> / {{ name }}</p>

    <SignalLoader v-if="loading && !detail" />
    <p v-else-if="errorMessage && !detail" class="error" role="alert">{{ errorMessage }}</p>

    <template v-else-if="detail">
      <PageHeader :title="detail.name">
        <TogglePill
          :on="detail.enabled"
          on-label="Disable composite"
          off-label="Enable composite"
          :aria-pressed="detail.enabled"
          @click="toggleEnabled"
        />
        <button type="button" class="btn-danger" :disabled="deleting" @click="requestDelete">
          {{ deleting ? "Deleting…" : "Delete composite" }}
        </button>
      </PageHeader>

      <p v-if="errorMessage" class="error" role="alert">{{ errorMessage }}</p>
      <p v-if="toggleError[detail.name]" class="error" role="alert">{{ toggleError[detail.name] }}</p>

      <FormField label="Description" for="composite-description" class="description-field">
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
      </FormField>

      <FormField label="Input schema (JSON)" for="composite-schema" class="json-field">
        <textarea id="composite-schema" v-model="schemaInput" rows="8" spellcheck="false"></textarea>
        <div class="field-actions">
          <button type="button" class="btn-primary" :disabled="!schemaDirty || savingSchema" @click="saveSchema">
            {{ savingSchema ? "Saving…" : "Save schema" }}
          </button>
        </div>
        <p v-if="schemaError" class="error">{{ schemaError }}</p>
      </FormField>

      <FormField label="Steps (JSON array)" for="composite-steps" class="json-field">
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
      </FormField>
    </template>

    <ConfirmDialog
      :open="pendingDelete !== null"
      title="Delete this composite?"
      :message="`MCP clients calling '${name}' will start failing immediately. This cannot be undone.`"
      :confirm-label="`Delete ${name}`"
      danger
      @confirm="confirmDelete"
      @cancel="cancelDelete"
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
</style>
