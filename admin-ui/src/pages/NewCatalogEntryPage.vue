<script setup lang="ts">
import { ref } from "vue";
import { useI18n } from "vue-i18n";
import { useRouter } from "vue-router";
import { api } from "@/composables/useApi";
import { toErrorMessage } from "@/utils/errors";
import { tk } from "@/i18n";
import PageHeader from "@/components/ui/PageHeader.vue";
import FormField from "@/components/ui/FormField.vue";
import FormPage from "@/components/ui/FormPage.vue";

const { t } = useI18n({ useScope: "global" });

const router = useRouter();

const slug = ref("");
const name = ref("");
const description = ref("");
const kind = ref<"rest" | "mcp">("rest");
const healthUrl = ref("");
const openapiUrl = ref("");
const mcpUrl = ref("");
const error = ref("");
const creating = ref(false);

async function createEntry() {
  error.value = "";
  if (!slug.value.trim() || !name.value.trim()) {
    error.value = t("pages.catalog.new.errors.slug_name_required");
    return;
  }
  creating.value = true;
  try {
    await api.post("/admin-api/catalog", {
      slug: slug.value.trim(),
      name: name.value.trim(),
      description: description.value.trim() || undefined,
      kind: kind.value,
      healthUrl: kind.value === "rest" ? healthUrl.value.trim() || undefined : undefined,
      openapiUrl: kind.value === "rest" ? openapiUrl.value.trim() || undefined : undefined,
      mcpUrl: kind.value === "mcp" ? mcpUrl.value.trim() || undefined : undefined,
    });
    await router.push("/catalog");
  } catch (err) {
    error.value = toErrorMessage(err, tk("pages.catalog.new.errors.create_failed"));
  } finally {
    creating.value = false;
  }
}
</script>

<template>
  <section>
    <FormPage max-width="30rem">
      <PageHeader :title="t('pages.catalog.new.title')" :back-link="{ to: '/catalog', label: t('nav.catalog') }" />

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
        </div>
        <template v-if="kind === 'rest'">
          <FormField :label="t('pages.catalog.new.fields.health_url')" for="ce-health">
            <input
              id="ce-health"
              v-model="healthUrl"
              type="url"
              :placeholder="t('pages.catalog.new.placeholders.health_url')"
            />
          </FormField>
          <FormField :label="t('pages.catalog.new.fields.openapi_url')" for="ce-openapi">
            <input
              id="ce-openapi"
              v-model="openapiUrl"
              type="url"
              :placeholder="t('pages.catalog.new.placeholders.openapi_url')"
            />
          </FormField>
        </template>
        <FormField v-else :label="t('pages.catalog.new.fields.mcp_url')" for="ce-mcp">
          <input id="ce-mcp" v-model="mcpUrl" type="url" :placeholder="t('pages.catalog.new.placeholders.mcp_url')" />
        </FormField>
        <p v-if="error" class="error">{{ error }}</p>
        <button type="submit" class="btn-primary" :disabled="creating">
          {{ creating ? t("common.saving") : t("pages.catalog.new.save") }}
        </button>
      </form>
    </FormPage>
  </section>
</template>

<style scoped>
.segmented {
  display: flex;
  gap: 1rem;
  font-size: 0.85rem;
}
</style>
