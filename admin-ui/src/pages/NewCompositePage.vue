<script setup lang="ts">
import { ref, computed } from "vue";
import { useRouter } from "vue-router";
import { api } from "@/composables/useApi";
import { toErrorMessage } from "@/utils/errors";
import type { CompositeDetail, CompositeStep } from "@/types/api";
import PageHeader from "@/components/ui/PageHeader.vue";
import FormField from "@/components/ui/FormField.vue";
import FormPage from "@/components/ui/FormPage.vue";

const router = useRouter();

const name = ref("");
const nameTouched = ref(false);
const description = ref("");
const schema = ref('{\n  "type": "object",\n  "properties": {}\n}');
const steps = ref(
  '[\n  { "targetClient": "docs", "targetTool": "search", "argsTemplate": { "query": "${input.query}" } },\n  { "targetClient": "docs", "targetTool": "get", "argsTemplate": { "id": { "$ref": "steps.0.json.id" } } }\n]',
);
const schemaError = ref("");
const stepsError = ref("");
const createError = ref("");
const creating = ref(false);

const nameError = computed(() => {
  const v = name.value.trim();
  if (!v) return null;
  return /^[a-z0-9][a-z0-9_-]{0,62}$/.test(v) && !v.includes("__")
    ? null
    : "Lowercase letters, digits, - and _ (max 63 chars); must not contain '__'.";
});

async function createComposite() {
  createError.value = "";
  schemaError.value = "";
  stepsError.value = "";
  nameTouched.value = true;
  if (!name.value.trim()) {
    createError.value = "Name is required.";
    return;
  }
  if (nameError.value) {
    return;
  }
  let inputSchema: Record<string, unknown>;
  let parsedSteps: CompositeStep[];
  try {
    inputSchema = JSON.parse(schema.value) as Record<string, unknown>;
  } catch {
    schemaError.value = "inputSchema is not valid JSON.";
    return;
  }
  try {
    parsedSteps = JSON.parse(steps.value) as CompositeStep[];
  } catch {
    stepsError.value = "steps is not valid JSON.";
    return;
  }
  creating.value = true;
  try {
    await api.post<CompositeDetail>("/admin-api/composites", {
      name: name.value.trim(),
      description: description.value.trim() || undefined,
      inputSchema,
      steps: parsedSteps,
    });
    await router.push(`/composites/${encodeURIComponent(name.value.trim())}`);
  } catch (err) {
    createError.value = toErrorMessage(err, "Failed to create composite.");
  } finally {
    creating.value = false;
  }
}
</script>

<template>
  <section>
    <FormPage max-width="50rem">
      <PageHeader title="New composite" :back-link="{ to: '/composites', label: 'Composites' }" />
      <p class="subtitle">
        Chains several existing tool calls into one, exposed on the aggregated MCP endpoint. Each step forwards to a
        real <code>client__tool</code> through the full guard stack.
      </p>

      <form class="create-form" @submit.prevent="createComposite">
        <FormField label="Name" for="new-composite-name">
          <input
            id="new-composite-name"
            v-model="name"
            type="text"
            placeholder="lowercase, no '__'"
            required
            @blur="nameTouched = true"
          />
          <p v-if="nameTouched && nameError" class="error">{{ nameError }}</p>
        </FormField>
        <FormField label="Description" for="new-composite-description">
          <input id="new-composite-description" v-model="description" type="text" placeholder="Optional" />
        </FormField>
        <FormField label="Input schema (JSON)" for="new-composite-schema">
          <textarea
            id="new-composite-schema"
            v-model="schema"
            class="mono-field"
            rows="4"
            spellcheck="false"
          ></textarea>
          <p v-if="schemaError" class="error">{{ schemaError }}</p>
        </FormField>
        <FormField label="Steps (JSON array)" for="new-composite-steps">
          <p class="template-hint">
            Templates: <code>{{ '{ "$ref": "steps.0.json.id" }' }}</code> or <code>{{ '"${input.query}"' }}</code
            >.
          </p>
          <textarea id="new-composite-steps" v-model="steps" class="mono-field" rows="6" spellcheck="false"></textarea>
          <p v-if="stepsError" class="error">{{ stepsError }}</p>
        </FormField>
        <p v-if="createError" class="error">{{ createError }}</p>
        <button class="btn-primary" type="submit" :disabled="creating">
          {{ creating ? "Creating…" : "Create composite" }}
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
.create-form {
  background: var(--surface);
  border: 1px solid var(--border);
  padding: 1.25rem;
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-xs);
  display: flex;
  flex-direction: column;
  gap: 0.8rem;
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
