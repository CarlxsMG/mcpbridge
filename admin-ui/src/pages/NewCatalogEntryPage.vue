<script setup lang="ts">
import { ref } from "vue";
import { useRouter } from "vue-router";
import { api } from "@/composables/useApi";
import { toErrorMessage } from "@/utils/errors";
import PageHeader from "@/components/ui/PageHeader.vue";
import FormField from "@/components/ui/FormField.vue";
import FormPage from "@/components/ui/FormPage.vue";

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
    error.value = "Slug and name are required.";
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
    error.value = toErrorMessage(err, "Failed to save catalog entry.");
  } finally {
    creating.value = false;
  }
}
</script>

<template>
  <section>
    <FormPage max-width="30rem">
      <PageHeader title="Add custom catalog entry" :back-link="{ to: '/catalog', label: 'Catalog' }" />

      <form class="create-form" @submit.prevent="createEntry">
        <FormField label="Slug" for="ce-slug">
          <input id="ce-slug" v-model="slug" type="text" placeholder="internal-crm-staging" required />
        </FormField>
        <FormField label="Name" for="ce-name">
          <input id="ce-name" v-model="name" type="text" placeholder="Internal CRM (staging)" required />
        </FormField>
        <FormField label="Description (optional)" for="ce-description">
          <input id="ce-description" v-model="description" type="text" placeholder="What this template registers" />
        </FormField>
        <div class="segmented" role="radiogroup" aria-label="Kind">
          <label><input v-model="kind" type="radio" name="ce-kind" value="rest" /> REST API</label>
          <label><input v-model="kind" type="radio" name="ce-kind" value="mcp" /> MCP server</label>
        </div>
        <template v-if="kind === 'rest'">
          <FormField label="Health URL" for="ce-health">
            <input id="ce-health" v-model="healthUrl" type="url" placeholder="https://api.example.com/health" />
          </FormField>
          <FormField label="OpenAPI URL" for="ce-openapi">
            <input id="ce-openapi" v-model="openapiUrl" type="url" placeholder="https://api.example.com/openapi.json" />
          </FormField>
        </template>
        <FormField v-else label="MCP server URL" for="ce-mcp">
          <input id="ce-mcp" v-model="mcpUrl" type="url" placeholder="https://mcp.example.com/mcp" />
        </FormField>
        <p v-if="error" class="error">{{ error }}</p>
        <button type="submit" class="btn-primary" :disabled="creating">
          {{ creating ? "Saving…" : "Save entry" }}
        </button>
      </form>
    </FormPage>
  </section>
</template>

<style scoped>
.create-form {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-xs);
  padding: 1.25rem;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}
.segmented {
  display: flex;
  gap: 1rem;
  font-size: 0.85rem;
}
</style>
