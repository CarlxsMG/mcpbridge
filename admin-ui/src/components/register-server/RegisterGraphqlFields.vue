<script setup lang="ts">
import { useI18n } from "vue-i18n";
import FormField from "@/components/ui/FormField.vue";

const { t } = useI18n({ useScope: "global" });

// Owned by the parent (read in register / previewGraphql); exposed as models.
const graphqlUrl = defineModel<string>("graphqlUrl", { required: true });
const graphqlHealthUrl = defineModel<string>("graphqlHealthUrl", { required: true });
const includeMutations = defineModel<boolean>("includeMutations", { required: true });
</script>

<template>
  <FormField :label="t('pages.register_server.graphql_url_label')" for="r-graphql-url">
    <input
      id="r-graphql-url"
      v-model="graphqlUrl"
      type="url"
      :placeholder="t('pages.register_server.graphql_url_placeholder')"
    />
  </FormField>
  <FormField :label="t('pages.register_server.graphql_health_label')" for="r-graphql-health">
    <input
      id="r-graphql-health"
      v-model="graphqlHealthUrl"
      type="url"
      :placeholder="t('pages.register_server.health_url_placeholder')"
    />
    <p class="hint">
      {{ t("pages.register_server.graphql_health_hint") }}
    </p>
  </FormField>
  <label class="checkline"
    ><input v-model="includeMutations" type="checkbox" />
    {{ t("pages.register_server.graphql_include_mutations") }}</label
  >
</template>

<style scoped>
.hint {
  font-size: 0.82rem;
  color: var(--text-secondary);
  margin: 0;
}
</style>
