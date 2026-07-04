<script setup lang="ts">
import { ref } from "vue";
import { useRouter } from "vue-router";
import { api } from "@/composables/useApi";
import { toErrorMessage } from "@/utils/errors";
import PageHeader from "@/components/ui/PageHeader.vue";
import FormField from "@/components/ui/FormField.vue";
import FormPage from "@/components/ui/FormPage.vue";

const router = useRouter();

const name = ref("");
const error = ref("");
const creating = ref(false);

async function createTeam() {
  error.value = "";
  if (!name.value.trim()) {
    error.value = "Name is required.";
    return;
  }
  creating.value = true;
  try {
    await api.post("/admin-api/teams", { name: name.value.trim() });
    await router.push("/teams");
  } catch (err) {
    error.value = toErrorMessage(err, "Failed to create team.");
  } finally {
    creating.value = false;
  }
}
</script>

<template>
  <section>
    <FormPage max-width="23.75rem">
      <PageHeader title="New team" :back-link="{ to: '/teams', label: 'Teams' }" />

      <form class="create-form" @submit.prevent="createTeam">
        <FormField label="Team name" for="new-team-name">
          <input id="new-team-name" v-model="name" type="text" placeholder="Team name (e.g. Payments)" required />
        </FormField>
        <p v-if="error" class="error">{{ error }}</p>
        <button class="btn-primary" type="submit" :disabled="creating">
          {{ creating ? "Creating…" : "Create team" }}
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
</style>
