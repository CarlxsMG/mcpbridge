<script setup lang="ts">
import { ref } from "vue";
import { useI18n } from "vue-i18n";
import { api } from "@/composables/useApi";
import { useCreateForm } from "@/composables/useCreateForm";
import PageHeader from "@/components/ui/PageHeader.vue";
import FormField from "@/components/ui/FormField.vue";
import FormPage from "@/components/ui/FormPage.vue";
import FieldError from "@/components/ui/FieldError.vue";

const { t } = useI18n({ useScope: "global" });

const name = ref("");

const { creating, error, run } = useCreateForm({
  submit: () => api.post("/admin-api/teams", { name: name.value.trim() }),
  redirectTo: "/teams",
  fallbackKey: "pages.teams.new.errors.create_failed",
});

function createTeam() {
  return run(() => (name.value.trim() ? null : t("pages.teams.new.errors.name_required")));
}
</script>

<template>
  <section>
    <FormPage max-width="23.75rem">
      <PageHeader :title="t('pages.teams.new.title')" :back-link="{ to: '/teams', label: t('nav.teams.label') }" />

      <form class="form-card" @submit.prevent="createTeam">
        <FormField :label="t('pages.teams.new.fields.name')" for="new-team-name">
          <input
            id="new-team-name"
            v-model="name"
            type="text"
            :placeholder="t('pages.teams.new.placeholders.name')"
            required
          />
        </FormField>
        <FieldError :message="error" />
        <button class="btn-primary" type="submit" :disabled="creating">
          {{ creating ? t("common.creating") : t("pages.teams.new.create") }}
        </button>
      </form>
    </FormPage>
  </section>
</template>
