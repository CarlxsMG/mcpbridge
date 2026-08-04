<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import type { UpstreamKind } from "@/types/api";
import { api } from "@/composables/useApi";
import { useCreateForm } from "@/composables/useCreateForm";
import PageHeader from "@/components/ui/PageHeader.vue";
import FormField from "@/components/ui/FormField.vue";
import FormPage from "@/components/ui/FormPage.vue";
import FieldError from "@/components/ui/FieldError.vue";
import UnsavedChangesDialog from "@/components/ui/UnsavedChangesDialog.vue";

const { t } = useI18n({ useScope: "global" });

const slug = ref("");
const name = ref("");
const description = ref("");
const kind = ref<UpstreamKind>("rest");
const healthUrl = ref("");
const openapiUrl = ref("");
const mcpUrl = ref("");
const graphqlUrl = ref("");

const { creating, error, errorRequestId, run } = useCreateForm({
  submit: () =>
    api.post("/admin-api/catalog", {
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
    }),
  redirectTo: "/catalog",
  fallbackKey: "pages.catalog.new.errors.create_failed",
});

function createEntry() {
  return run(() => (slug.value.trim() && name.value.trim() ? null : t("pages.catalog.new.errors.slug_name_required")));
}

const isDirty = computed(
  () =>
    Boolean(slug.value.trim()) ||
    Boolean(name.value.trim()) ||
    Boolean(description.value.trim()) ||
    kind.value !== "rest" ||
    Boolean(healthUrl.value.trim()) ||
    Boolean(openapiUrl.value.trim()) ||
    Boolean(mcpUrl.value.trim()) ||
    Boolean(graphqlUrl.value.trim()),
);
</script>

<template>
  <section>
    <FormPage max-width="30rem">
      <PageHeader
        :title="t('pages.catalog.new.title')"
        :back-link="{ to: '/catalog', label: t('nav.catalog.label') }"
      />

      <form class="form-card" @submit.prevent="createEntry">
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
          {{ creating ? t("common.saving") : t("pages.catalog.new.save") }}
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
