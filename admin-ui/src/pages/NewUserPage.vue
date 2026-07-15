<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { api } from "@/composables/useApi";
import { useCreateForm } from "@/composables/useCreateForm";
import { useUnsavedChangesGuard } from "@/composables/useUnsavedChangesGuard";
import type { AdminRole } from "@/types/api";
import PageHeader from "@/components/ui/PageHeader.vue";
import FormField from "@/components/ui/FormField.vue";
import SelectMenu from "@/components/ui/SelectMenu.vue";
import FormPage from "@/components/ui/FormPage.vue";
import FieldError from "@/components/ui/FieldError.vue";
import ConfirmDialog from "@/components/ui/ConfirmDialog.vue";

const { t } = useI18n({ useScope: "global" });

const NEW_ROLE_OPTIONS: { value: AdminRole; label: string }[] = [
  { value: "admin", label: t("pages.users.new.roles.admin") },
  { value: "operator", label: t("pages.users.new.roles.operator") },
  { value: "auditor", label: t("pages.users.new.roles.auditor") },
  { value: "viewer", label: t("pages.users.new.roles.viewer") },
];

const username = ref("");
const password = ref("");
const role = ref<AdminRole>("viewer");

const { creating, error, run } = useCreateForm({
  submit: () =>
    api.post("/admin-api/users", {
      username: username.value.trim(),
      password: password.value,
      role: role.value,
    }),
  redirectTo: "/users",
  fallbackKey: "pages.users.new.errors.create_failed",
});

function createUser() {
  return run(() => (password.value.length < 12 ? t("pages.users.new.errors.password_too_short") : null));
}

const isDirty = computed(() => Boolean(username.value.trim()) || password.value.length > 0 || role.value !== "viewer");
const { pendingLeave, confirmLeave, cancelLeave } = useUnsavedChangesGuard(isDirty, () => creating.value);
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
        <FieldError :message="error" />
        <button type="submit" class="btn-primary" :disabled="creating">
          {{ creating ? t("common.creating") : t("pages.users.new.create") }}
        </button>
      </form>
    </FormPage>

    <ConfirmDialog
      :open="pendingLeave"
      :title="t('pages.users.new.confirm.leave_title')"
      :message="t('pages.users.new.confirm.leave_message')"
      :confirm-label="t('pages.users.new.confirm.leave_cta')"
      danger
      @confirm="confirmLeave"
      @cancel="cancelLeave"
    />
  </section>
</template>
