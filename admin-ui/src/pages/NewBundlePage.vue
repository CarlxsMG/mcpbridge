<script setup lang="ts">
import { ref } from "vue";
import { useRouter } from "vue-router";
import { api } from "@/composables/useApi";
import { toErrorMessage } from "@/utils/errors";
import type { BundleDetail, BundleToolRef } from "@/types/api";
import BundleToolPicker from "@/components/BundleToolPicker.vue";
import PageHeader from "@/components/ui/PageHeader.vue";
import FormField from "@/components/ui/FormField.vue";
import FormPage from "@/components/ui/FormPage.vue";

const router = useRouter();

const name = ref("");
const description = ref("");
const tools = ref<BundleToolRef[]>([]);
const creating = ref(false);
const error = ref("");

async function createBundle() {
  error.value = "";
  if (!name.value.trim()) {
    error.value = "Name is required.";
    return;
  }
  creating.value = true;
  try {
    await api.post<BundleDetail>("/admin-api/bundles", {
      name: name.value.trim(),
      description: description.value.trim() || undefined,
      tools: tools.value,
    });
    await router.push(`/bundles/${encodeURIComponent(name.value.trim())}`);
  } catch (err) {
    error.value = toErrorMessage(err, "Failed to create bundle.");
  } finally {
    creating.value = false;
  }
}
</script>

<template>
  <section>
    <FormPage max-width="50rem">
      <PageHeader title="Create bundle" :back-link="{ to: '/bundles', label: 'Bundles' }" />
      <p class="subtitle">
        Cross-client tool selections, each served at its own <code>/mcp-custom/&lt;name&gt;</code> endpoint.
      </p>

      <form class="create-form" @submit.prevent="createBundle">
        <FormField label="Name" for="new-bundle-name">
          <input id="new-bundle-name" v-model="name" type="text" placeholder="e.g. assistant-a" required />
        </FormField>
        <p v-if="error" class="error">{{ error }}</p>
        <FormField label="Description (optional)" for="new-bundle-description">
          <input id="new-bundle-description" v-model="description" type="text" placeholder="What this bundle is for" />
        </FormField>
        <div class="field">
          <label>Tools</label>
          <BundleToolPicker v-model="tools" />
        </div>
        <button type="submit" class="btn-primary" :disabled="creating">
          {{ creating ? "Creating…" : "Create bundle" }}
        </button>
      </form>
    </FormPage>
  </section>
</template>

<style scoped>
.subtitle {
  color: var(--text-secondary);
  margin: 0 0 1.25rem;
}
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
.field label {
  display: block;
  font-size: 0.85rem;
  font-weight: 600;
  margin-bottom: 0.3rem;
}
</style>
