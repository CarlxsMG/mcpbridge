<script setup lang="ts">
import { ref, computed } from "vue";
import { useI18n } from "vue-i18n";
import { api } from "@/composables/useApi";
import { useCreateForm } from "@/composables/useCreateForm";
import type { CompositeDetail, CompositeStep } from "@/types/api";
import PageHeader from "@/components/ui/PageHeader.vue";
import FormField from "@/components/ui/FormField.vue";
import FormPage from "@/components/ui/FormPage.vue";
import FieldError from "@/components/ui/FieldError.vue";

const { t } = useI18n({ useScope: "global" });

const name = ref("");
const nameTouched = ref(false);
const description = ref("");
const schema = ref('{\n  "type": "object",\n  "properties": {}\n}');
const steps = ref(
  '[\n  { "targetClient": "docs", "targetTool": "search", "argsTemplate": { "query": "${input.query}" } },\n  { "targetClient": "docs", "targetTool": "get", "argsTemplate": { "id": { "$ref": "steps.0.json.id" } } }\n]',
);
const schemaError = ref("");
const stepsError = ref("");

const nameError = computed(() => {
  const v = name.value.trim();
  if (!v) return null;
  return /^[a-z0-9][a-z0-9_-]{0,62}$/.test(v) && !v.includes("__")
    ? null
    : t("pages.composites.new.errors.name_format");
});

const { creating, error, run } = useCreateForm({
  submit: () =>
    api.post<CompositeDetail>("/admin-api/composites", {
      name: name.value.trim(),
      description: description.value.trim() || undefined,
      inputSchema: JSON.parse(schema.value) as Record<string, unknown>,
      steps: JSON.parse(steps.value) as CompositeStep[],
    }),
  redirectTo: (composite) => `/composites/${encodeURIComponent(composite.name)}`,
  fallbackKey: "pages.composites.new.errors.create_failed",
});

function createComposite() {
  error.value = "";
  schemaError.value = "";
  stepsError.value = "";
  nameTouched.value = true;
  if (!name.value.trim()) {
    error.value = t("pages.composites.new.errors.name_required");
    return;
  }
  if (nameError.value) {
    return;
  }
  try {
    JSON.parse(schema.value);
  } catch {
    schemaError.value = t("pages.composites.new.errors.schema_invalid");
    return;
  }
  try {
    JSON.parse(steps.value);
  } catch {
    stepsError.value = t("pages.composites.new.errors.steps_invalid");
    return;
  }
  return run();
}
</script>

<template>
  <section>
    <FormPage max-width="50rem">
      <PageHeader
        :title="t('pages.composites.new.title')"
        :back-link="{ to: '/composites', label: t('nav.composites.label') }"
      />
      <p class="subtitle">
        {{ t("pages.composites.new.subtitle_p1") }} <code>client__tool</code>
        {{ t("pages.composites.new.subtitle_p2") }}
      </p>

      <form class="form-card" @submit.prevent="createComposite">
        <FormField :label="t('pages.composites.new.fields.name')" for="new-composite-name">
          <input
            id="new-composite-name"
            v-model="name"
            type="text"
            :placeholder="t('pages.composites.new.placeholders.name')"
            required
            @blur="nameTouched = true"
          />
          <p v-if="nameTouched && nameError" class="error">{{ nameError }}</p>
        </FormField>
        <FormField :label="t('pages.composites.new.fields.description')" for="new-composite-description">
          <input
            id="new-composite-description"
            v-model="description"
            type="text"
            :placeholder="t('pages.composites.new.placeholders.description')"
          />
        </FormField>
        <FormField :label="t('pages.composites.new.fields.schema')" for="new-composite-schema">
          <textarea
            id="new-composite-schema"
            v-model="schema"
            class="mono-field"
            rows="4"
            spellcheck="false"
          ></textarea>
          <p v-if="schemaError" class="error">{{ schemaError }}</p>
        </FormField>
        <FormField :label="t('pages.composites.new.fields.steps')" for="new-composite-steps">
          <p class="template-hint">
            {{ t("pages.composites.new.templates.label") }} <code>{{ '{ "$ref": "steps.0.json.id" }' }}</code>
            {{ t("pages.composites.new.templates.or") }} <code>{{ '"${input.query}"' }}</code
            >.
          </p>
          <textarea id="new-composite-steps" v-model="steps" class="mono-field" rows="6" spellcheck="false"></textarea>
          <p v-if="stepsError" class="error">{{ stepsError }}</p>
        </FormField>
        <FieldError :message="error" />
        <button class="btn-primary" type="submit" :disabled="creating">
          {{ creating ? t("common.creating") : t("pages.composites.new.create") }}
        </button>
      </form>
    </FormPage>
  </section>
</template>

<style scoped>
.subtitle {
  color: var(--text-secondary);
  margin: 0 0 1.25rem;
  max-width: 35rem;
}
.field textarea.mono-field {
  font-family: var(--font-mono);
  font-size: 0.85rem;
}
.template-hint {
  color: var(--text-secondary);
  font-size: 0.82rem;
  margin: 0 0 0.4rem;
}
</style>
