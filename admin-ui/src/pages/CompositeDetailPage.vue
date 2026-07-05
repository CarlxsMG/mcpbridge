<script setup lang="ts">
import { computed, watch, onMounted } from "vue";
import { api, ApiError } from "@/composables/useApi";
import { useResource } from "@/composables/useResource";
import { useOptimisticToggle } from "@/composables/useOptimisticToggle";
import { useUnsavedChangesGuard } from "@/composables/useUnsavedChangesGuard";
import { useFieldDraft } from "@/composables/useFieldDraft";
import { useDetailPageDelete, syncAfterLoad } from "@/composables/useDetailPageDelete";
import type { CompositeDetail, CompositeStep } from "@/types/api";
import ConfirmDialog from "@/components/ui/ConfirmDialog.vue";
import SignalLoader from "@/components/ui/SignalLoader.vue";
import PageHeader from "@/components/ui/PageHeader.vue";
import FormField from "@/components/ui/FormField.vue";
import TogglePill from "@/components/ui/TogglePill.vue";

const props = defineProps<{ name: string }>();

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
    await api.patch(`/admin-api/composites/${encodeURIComponent(props.name)}`, { description: value || null });
    await load();
  },
  { fallbackMessage: "Failed to save description." },
);

const {
  draft: schemaInput,
  dirty: schemaDirty,
  saving: savingSchema,
  errorMessage: schemaError,
  sync: syncSchema,
  commit: saveSchema,
} = useFieldDraft(
  () => JSON.stringify(detail.value?.inputSchema ?? {}, null, 2),
  async (value) => {
    let inputSchema: Record<string, unknown>;
    try {
      inputSchema = JSON.parse(value) as Record<string, unknown>;
    } catch {
      throw new ApiError(0, "INVALID_JSON", "inputSchema is not valid JSON.");
    }
    await api.patch(`/admin-api/composites/${encodeURIComponent(props.name)}`, { inputSchema });
    await load();
  },
  { fallbackMessage: "Failed to save input schema." },
);

const {
  draft: stepsInput,
  dirty: stepsDirty,
  saving: savingSteps,
  errorMessage: stepsError,
  sync: syncSteps,
  commit: saveSteps,
} = useFieldDraft(
  () => JSON.stringify(detail.value?.steps ?? [], null, 2),
  async (value) => {
    let steps: CompositeStep[];
    try {
      steps = JSON.parse(value) as CompositeStep[];
    } catch {
      throw new ApiError(0, "INVALID_JSON", "steps is not valid JSON.");
    }
    await api.patch(`/admin-api/composites/${encodeURIComponent(props.name)}`, { steps });
    await load();
  },
  { fallbackMessage: "Failed to save steps." },
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
  () => `/admin-api/composites/${encodeURIComponent(props.name)}`,
  "/composites",
  "Failed to delete composite.",
);

async function load() {
  await syncAfterLoad(loadDetail, syncDescription, syncSchema, syncSteps);
}
watch(() => props.name, load);
onMounted(load);

const isDirty = computed(() => descriptionDirty.value || schemaDirty.value || stepsDirty.value);

const { pendingLeave, confirmLeave, cancelLeave } = useUnsavedChangesGuard(
  () => isDirty.value,
  () => deleted.value,
);

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
      <p v-if="deleteError" class="row-error">{{ deleteError }}</p>

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
        <p v-if="descriptionError" class="error">{{ descriptionError }}</p>
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
