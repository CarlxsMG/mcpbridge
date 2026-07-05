<script setup lang="ts">
import { ref } from "vue";
import { useI18n } from "vue-i18n";
import { useRouter } from "vue-router";
import { api } from "@/composables/useApi";
import { toErrorMessage } from "@/utils/errors";
import { tk } from "@/i18n";
import type { AdminRole } from "@/types/api";
import PageHeader from "@/components/ui/PageHeader.vue";
import FormField from "@/components/ui/FormField.vue";
import SelectMenu from "@/components/ui/SelectMenu.vue";
import FormPage from "@/components/ui/FormPage.vue";

const { t } = useI18n({ useScope: "global" });

const NEW_ROLE_OPTIONS: { value: AdminRole; label: string }[] = [
  { value: "admin", label: t("pages.users.new.roles.admin") },
  { value: "operator", label: t("pages.users.new.roles.operator") },
  { value: "auditor", label: t("pages.users.new.roles.auditor") },
  { value: "viewer", label: t("pages.users.new.roles.viewer") },
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
    error.value = t("pages.users.new.errors.password_too_short");
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
    error.value = toErrorMessage(err, tk("pages.users.new.errors.create_failed"));
  } finally {
    creating.value = false;
  }
}
</script>

<template>
  <section>
    <FormPage max-width="23.75rem">
      <PageHeader :title="t('pages.users.new.title')" :back-link="{ to: '/users', label: t('nav.users.label') }" />

      <form class="form-card" @submit.prevent="createUser">
        <FormField :label="t('pages.users.new.fields.username')" for="new-username">
          <input id="new-username" v-model="username" type="text" required />
        </FormField>
        <FormField :label="t('pages.users.new.fields.password')" for="new-password">
          <input id="new-password" v-model="password" type="password" required minlength="12" />
        </FormField>
        <FormField :label="t('pages.users.new.fields.role')" for="new-role">
          <SelectMenu id="new-role" v-model="role" :options="NEW_ROLE_OPTIONS" />
        </FormField>
        <p v-if="error" class="error">{{ error }}</p>
        <button type="submit" class="btn-primary" :disabled="creating">
          {{ creating ? t("common.creating") : t("pages.users.new.create") }}
        </button>
      </form>
    </FormPage>
  </section>
</template>
