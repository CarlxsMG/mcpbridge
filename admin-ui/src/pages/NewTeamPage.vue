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

const name = ref("");
const error = ref("");
const creating = ref(false);

async function createTeam() {
  error.value = "";
  if (!name.value.trim()) {
    error.value = t("pages.teams.new.errors.name_required");
    return;
  }
  creating.value = true;
  try {
    await api.post("/admin-api/teams", { name: name.value.trim() });
    await router.push("/teams");
  } catch (err) {
    error.value = toErrorMessage(err, tk("pages.teams.new.errors.create_failed"));
  } finally {
    creating.value = false;
  }
}
</script>

<template>
  <section>
    <FormPage max-width="23.75rem">
      <PageHeader :title="t('pages.teams.new.title')" :back-link="{ to: '/teams', label: t('nav.teams') }" />

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
        <p v-if="error" class="error">{{ error }}</p>
        <button class="btn-primary" type="submit" :disabled="creating">
          {{ creating ? t("common.creating") : t("pages.teams.new.create") }}
        </button>
      </form>
    </FormPage>
  </section>
</template>
