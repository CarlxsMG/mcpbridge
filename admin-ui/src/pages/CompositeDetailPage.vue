<script setup lang="ts">
import { computed, watch, onMounted } from "vue";
import { useI18n } from "vue-i18n";
import { api, ApiError } from "@/composables/useApi";
import { useResource } from "@/composables/useResource";
import { useOptimisticToggle } from "@/composables/useOptimisticToggle";
import { useUnsavedChangesGuard } from "@/composables/useUnsavedChangesGuard";
import { useFieldDraft } from "@/composables/useFieldDraft";
import { useDetailPageDelete, syncAfterLoad } from "@/composables/useDetailPageDelete";
import { compositePath } from "@/utils/apiPaths";
import { prettyJson } from "@/utils/format";
import { tk } from "@/i18n";
import type { CompositeDetail, CompositeStep } from "@/types/api";
import ConfirmDialog from "@/components/ui/ConfirmDialog.vue";
import SignalLoader from "@/components/ui/SignalLoader.vue";
import PageHeader from "@/components/ui/PageHeader.vue";
import FormField from "@/components/ui/FormField.vue";
import TogglePill from "@/components/ui/TogglePill.vue";
import FieldError from "@/components/ui/FieldError.vue";

const props = defineProps<{ name: string }>();
const { t } = useI18n({ useScope: "global" });

const {
  data: detail,
  loading,
  errorMessage,
  load: loadDetail,
} = useResource<CompositeDetail | null>(
  () => api.get<CompositeDetail>(compositePath(props.name)),
  null,
  tk("pages.composite_detail.errors.load_failed"),
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
    await api.patch(compositePath(props.name), { description: value || null });
    await load();
  },
  { fallbackMessage: tk("pages.composite_detail.errors.save_description_failed") },
);

const {
  draft: schemaInput,
  dirty: schemaDirty,
  saving: savingSchema,
  errorMessage: schemaError,
  sync: syncSchema,
  commit: saveSchema,
} = useFieldDraft(
  () => prettyJson(detail.value?.inputSchema ?? {}),
  async (value) => {
    let inputSchema: Record<string, unknown>;
    try {
      inputSchema = JSON.parse(value) as Record<string, unknown>;
    } catch {
      throw new ApiError(0, "INVALID_JSON", t("pages.composite_detail.errors.schema_invalid"));
    }
    await api.patch(compositePath(props.name), { inputSchema });
    await load();
  },
  { fallbackMessage: tk("pages.composite_detail.errors.save_schema_failed") },
);

const {
  draft: stepsInput,
  dirty: stepsDirty,
  saving: savingSteps,
  errorMessage: stepsError,
  sync: syncSteps,
  commit: saveSteps,
} = useFieldDraft(
  () => prettyJson(detail.value?.steps ?? []),
  async (value) => {
    let steps: CompositeStep[];
    try {
      steps = JSON.parse(value) as CompositeStep[];
    } catch {
      throw new ApiError(0, "INVALID_JSON", t("pages.composite_detail.errors.steps_invalid"));
    }
    await api.patch(compositePath(props.name), { steps });
    await load();
  },
  { fallbackMessage: tk("pages.composite_detail.errors.save_steps_failed") },
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
  () => compositePath(props.name),
  "/composites",
  tk("pages.composite_detail.errors.delete_failed"),
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
  tk("pages.composite_detail.errors.toggle_failed"),
);

function toggleEnabled() {
  if (!detail.value) return;
  toggleEnabledField(detail.value, "enabled", (next) => api.patch(compositePath(props.name), { enabled: next }));
}
</script>

<template>
  <section>
    <p class="breadcrumb">
      <RouterLink to="/composites">{{ t("nav.composites.label") }}</RouterLink> / {{ name }}
    </p>

    <SignalLoader v-if="loading && !detail" />
    <p v-else-if="errorMessage && !detail" class="error" role="alert">{{ errorMessage }}</p>

    <template v-else-if="detail">
      <PageHeader :title="detail.name">
        <TogglePill
          :on="detail.enabled"
          :on-label="t('pages.composite_detail.disable')"
          :off-label="t('pages.composite_detail.enable')"
          @click="toggleEnabled"
        />
        <button type="button" class="btn-danger" :disabled="deleting" @click="requestDelete">
          {{ deleting ? t("pages.composite_detail.deleting") : t("pages.composite_detail.delete") }}
        </button>
      </PageHeader>

      <p v-if="errorMessage" class="error" role="alert">{{ errorMessage }}</p>
      <p v-if="toggleError[detail.name]" class="error" role="alert">{{ toggleError[detail.name] }}</p>
      <p v-if="deleteError" class="row-error">{{ deleteError }}</p>

      <FormField
        :label="t('pages.composite_detail.description_label')"
        for="composite-description"
        class="description-field"
      >
        <div class="description-row">
          <input
            id="composite-description"
            v-model="descriptionInput"
            type="text"
            :placeholder="t('pages.composite_detail.description_placeholder')"
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
        <FieldError :message="descriptionError" />
      </FormField>

      <FormField :label="t('pages.composite_detail.schema_label')" for="composite-schema" class="json-field">
        <textarea id="composite-schema" v-model="schemaInput" rows="8" spellcheck="false"></textarea>
        <div class="field-actions">
          <button type="button" class="btn-primary" :disabled="!schemaDirty || savingSchema" @click="saveSchema">
            {{ savingSchema ? t("common.saving") : t("pages.composite_detail.save_schema") }}
          </button>
        </div>
        <FieldError :message="schemaError" />
      </FormField>

      <FormField :label="t('pages.composite_detail.steps_label')" for="composite-steps" class="json-field">
        <p class="template-hint">
          {{ t("pages.composite_detail.templates.label") }} <code>{{ '{ "$ref": "steps.0.json.id" }' }}</code>
          {{ t("pages.composite_detail.templates.or") }} <code>{{ '"${input.name}"' }}</code
          >.
        </p>
        <textarea id="composite-steps" v-model="stepsInput" rows="10" spellcheck="false"></textarea>
        <div class="field-actions">
          <button type="button" class="btn-primary" :disabled="!stepsDirty || savingSteps" @click="saveSteps">
            {{ savingSteps ? t("common.saving") : t("pages.composite_detail.save_steps") }}
          </button>
        </div>
        <FieldError :message="stepsError" />
      </FormField>
    </template>

    <ConfirmDialog
      :open="pendingDelete !== null"
      :title="t('pages.composite_detail.confirm.delete_title')"
      :message="t('pages.composite_detail.confirm.delete_message', { name })"
      :confirm-label="t('pages.composite_detail.confirm.delete_cta', { name })"
      danger
      @confirm="confirmDelete"
      @cancel="cancelDelete"
    />

    <ConfirmDialog
      :open="pendingLeave"
      :title="t('pages.composite_detail.confirm.leave_title')"
      :message="t('pages.composite_detail.confirm.leave_message')"
      :confirm-label="t('pages.composite_detail.confirm.leave_cta')"
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
