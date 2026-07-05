<script setup lang="ts">
import { ref } from "vue";
import { useRouter } from "vue-router";
import { api } from "@/composables/useApi";
import { toErrorMessage } from "@/utils/errors";
import type { AdminRole } from "@/types/api";
import PageHeader from "@/components/ui/PageHeader.vue";
import FormField from "@/components/ui/FormField.vue";
import SelectMenu from "@/components/ui/SelectMenu.vue";
import FormPage from "@/components/ui/FormPage.vue";

const NEW_ROLE_OPTIONS: { value: AdminRole; label: string }[] = [
  { value: "admin", label: "Admin" },
  { value: "operator", label: "Operator" },
  { value: "auditor", label: "Auditor" },
  { value: "viewer", label: "Viewer" },
];

const router = useRouter();

const username = ref("");
const password = ref("");
const role = ref<AdminRole>("viewer");
const error = ref("");
const creating = ref(false);

async function createUser() {
  error.value = "";
  if (password.value.length < 12) {
    error.value = "Password must be at least 12 characters.";
    return;
  }
  creating.value = true;
  try {
    await api.post("/admin-api/users", {
      username: username.value.trim(),
      password: password.value,
      role: role.value,
    });
    await router.push("/users");
  } catch (err) {
    error.value = toErrorMessage(err, "Failed to create user.");
  } finally {
    creating.value = false;
  }
}
</script>

<template>
  <section>
    <FormPage max-width="23.75rem">
      <PageHeader title="Add user" :back-link="{ to: '/users', label: 'Users' }" />

      <form class="form-card" @submit.prevent="createUser">
        <FormField label="Username" for="new-username">
          <input id="new-username" v-model="username" type="text" required />
        </FormField>
        <FormField label="Password (min 12 chars)" for="new-password">
          <input id="new-password" v-model="password" type="password" required minlength="12" />
        </FormField>
        <FormField label="Role" for="new-role">
          <SelectMenu id="new-role" v-model="role" :options="NEW_ROLE_OPTIONS" />
        </FormField>
        <p v-if="error" class="error">{{ error }}</p>
        <button type="submit" class="btn-primary" :disabled="creating">
          {{ creating ? "Creating…" : "Create user" }}
        </button>
      </form>
    </FormPage>
  </section>
</template>
