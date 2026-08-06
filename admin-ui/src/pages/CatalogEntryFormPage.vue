<script setup lang="ts">
// Dual-mode form: create at /catalog/new, edit at /catalog/:id/edit. See
// PolicyFormPage.vue for why create and edit share one component.
//
// Catalog-specific constraint: only `custom:` entries are editable. The
// backend answers 403 IMMUTABLE_ENTRY for a `builtin:` id, so CatalogPage
// renders the Edit link on custom entries only — but this page still guards
// the id itself, because the route is reachable by typing a URL and a 403 with
// no explanation is a worse answer than saying which entries can be edited.
//
// As with policies there is no GET /admin-api/catalog/:id, so edit mode
// prefills by finding its row in the collection response.
import { computed, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import type { CatalogEntry, UpstreamKind } from "@/types/api";
import { api } from "@/composables/useApi";
import { useCreateForm } from "@/composables/useCreateForm";
import { toErrorMessage } from "@/utils/errors";
import { tk } from "@/i18n";
import PageHeader from "@/components/ui/PageHeader.vue";
import FormField from "@/components/ui/FormField.vue";
import FormPage from "@/components/ui/FormPage.vue";
import FieldError from "@/components/ui/FieldError.vue";
import SignalLoader from "@/components/ui/SignalLoader.vue";
import UnsavedChangesDialog from "@/components/ui/UnsavedChangesDialog.vue";

const props = defineProps<{ id?: string }>();

const { t } = useI18n({ useScope: "global" });

const isEdit = computed(() => props.id !== undefined);

const slug = ref("");
const name = ref("");
const description = ref("");
const kind = ref<UpstreamKind>("rest");
const healthUrl = ref("");
const openapiUrl = ref("");
const mcpUrl = ref("");
const graphqlUrl = ref("");

const loading = ref(false);
const loadError = ref("");
// See PolicyFormPage: in edit mode `isDirty` compares against what loaded, so
// leaving an untouched edit page doesn't trip the unsaved-changes dialog.
const loaded = ref("");

function snapshot(): string {
  return JSON.stringify([
    slug.value,
    name.value,
    description.value,
    kind.value,
    healthUrl.value,
    openapiUrl.value,
    mcpUrl.value,
    graphqlUrl.value,
  ]);
}

const { creating, error, errorRequestId, run } = useCreateForm({
  submit: () => {
    const payload = {
      slug: slug.value.trim(),
      name: name.value.trim(),
      description: description.value.trim() || undefined,
      kind: kind.value,
      // health_url is offered for GraphQL too: performGraphqlRegistration
      // defaults it to the operation endpoint, and many GraphQL servers reject
      // a bare GET there, which reads as a failing health check.
      healthUrl: kind.value === "mcp" ? undefined : healthUrl.value.trim() || undefined,
      openapiUrl: kind.value === "rest" ? openapiUrl.value.trim() || undefined : undefined,
      mcpUrl: kind.value === "mcp" ? mcpUrl.value.trim() || undefined : undefined,
      graphqlUrl: kind.value === "graphql" ? graphqlUrl.value.trim() || undefined : undefined,
    };
    return isEdit.value
      ? api.patch(`/admin-api/catalog/${encodeURIComponent(props.id ?? "")}`, payload)
      : api.post("/admin-api/catalog", payload);
  },
  redirectTo: "/catalog",
  // Mode-specific: a failed PATCH saying "could not create" is a wrong answer.
  // Safe to read `isEdit` once here — the route param can't change without
  // remounting the component.
  fallbackKey: isEdit.value ? "pages.catalog.edit.save_failed" : "pages.catalog.new.errors.create_failed",
});

onMounted(async () => {
  if (!isEdit.value) return;
  if (!props.id?.startsWith("custom:")) {
    loadError.value = t("pages.catalog.edit.builtin_immutable");
    return;
  }
  loading.value = true;
  try {
    const res = await api.get<{ items: CatalogEntry[] }>("/admin-api/catalog");
    const entry = res.items.find((x) => x.id === props.id);
    if (!entry) {
      loadError.value = t("pages.catalog.edit.not_found");
      return;
    }
    slug.value = entry.slug;
    name.value = entry.name;
    description.value = entry.description ?? "";
    kind.value = entry.kind;
    healthUrl.value = entry.healthUrl ?? "";
    openapiUrl.value = entry.openapiUrl ?? "";
    mcpUrl.value = entry.mcpUrl ?? "";
    graphqlUrl.value = entry.graphqlUrl ?? "";
    loaded.value = snapshot();
  } catch (err) {
    loadError.value = toErrorMessage(err, tk("pages.catalog.edit.load_failed"));
  } finally {
    loading.value = false;
  }
});

function submitEntry() {
  return run(() => (slug.value.trim() && name.value.trim() ? null : t("pages.catalog.new.errors.slug_name_required")));
}

const isDirty = computed(() => {
  if (isEdit.value) return loaded.value !== "" && snapshot() !== loaded.value;
  return (
    Boolean(slug.value.trim()) ||
    Boolean(name.value.trim()) ||
    Boolean(description.value.trim()) ||
    kind.value !== "rest" ||
    Boolean(healthUrl.value.trim()) ||
    Boolean(openapiUrl.value.trim()) ||
    Boolean(mcpUrl.value.trim()) ||
    Boolean(graphqlUrl.value.trim())
  );
});
</script>

<template>
  <section>
    <FormPage max-width="30rem">
      <PageHeader
        :title="isEdit ? t('pages.catalog.edit.title') : t('pages.catalog.new.title')"
        :back-link="{ to: '/catalog', label: t('nav.catalog.label') }"
      />

      <SignalLoader v-if="loading" />
      <FieldError v-else-if="loadError" :message="loadError" />

      <form v-else class="form-card" @submit.prevent="submitEntry">
        <FormField :label="t('pages.catalog.new.fields.slug')" for="ce-slug">
          <input
            id="ce-slug"
            v-model="slug"
            type="text"
            :placeholder="t('pages.catalog.new.placeholders.slug')"
            required
          />
        </FormField>
        <FormField :label="t('pages.catalog.new.fields.name')" for="ce-name">
          <input
            id="ce-name"
            v-model="name"
            type="text"
            :placeholder="t('pages.catalog.new.placeholders.name')"
            required
          />
        </FormField>
        <FormField :label="t('pages.catalog.new.fields.description')" for="ce-description">
          <input
            id="ce-description"
            v-model="description"
            type="text"
            :placeholder="t('pages.catalog.new.placeholders.description')"
          />
        </FormField>
        <div class="segmented" role="radiogroup" :aria-label="t('pages.catalog.new.kind_aria')">
          <label
            ><input v-model="kind" type="radio" name="ce-kind" value="rest" />
            {{ t("pages.catalog.new.kind_rest") }}</label
          >
          <label
            ><input v-model="kind" type="radio" name="ce-kind" value="mcp" />
            {{ t("pages.catalog.new.kind_mcp") }}</label
          >
          <label
            ><input v-model="kind" type="radio" name="ce-kind" value="graphql" />
            {{ t("pages.catalog.new.kind_graphql") }}</label
          >
        </div>
        <FormField v-if="kind !== 'mcp'" :label="t('pages.catalog.new.fields.health_url')" for="ce-health">
          <input
            id="ce-health"
            v-model="healthUrl"
            type="url"
            :placeholder="t('pages.catalog.new.placeholders.health_url')"
          />
          <p v-if="kind === 'graphql'" class="hint">{{ t("pages.catalog.new.hints.graphql_health_url") }}</p>
        </FormField>
        <FormField v-if="kind === 'rest'" :label="t('pages.catalog.new.fields.openapi_url')" for="ce-openapi">
          <input
            id="ce-openapi"
            v-model="openapiUrl"
            type="url"
            :placeholder="t('pages.catalog.new.placeholders.openapi_url')"
          />
        </FormField>
        <FormField v-if="kind === 'mcp'" :label="t('pages.catalog.new.fields.mcp_url')" for="ce-mcp">
          <input id="ce-mcp" v-model="mcpUrl" type="url" :placeholder="t('pages.catalog.new.placeholders.mcp_url')" />
        </FormField>
        <FormField v-if="kind === 'graphql'" :label="t('pages.catalog.new.fields.graphql_url')" for="ce-graphql">
          <input
            id="ce-graphql"
            v-model="graphqlUrl"
            type="url"
            :placeholder="t('pages.catalog.new.placeholders.graphql_url')"
          />
        </FormField>
        <FieldError :message="error" :request-id="errorRequestId" />
        <button type="submit" class="btn-primary" :disabled="creating">
          {{ creating ? t("common.saving") : isEdit ? t("common.save_changes") : t("pages.catalog.new.save") }}
        </button>
      </form>
    </FormPage>

    <UnsavedChangesDialog :dirty="isDirty" :bypass="creating" />
  </section>
</template>

<style scoped>
.segmented {
  display: flex;
  gap: 1rem;
  font-size: 0.85rem;
}
</style>
