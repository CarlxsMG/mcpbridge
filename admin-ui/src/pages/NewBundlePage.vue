<script setup lang="ts">
import { ref } from "vue";
import { useI18n } from "vue-i18n";
import { useRouter } from "vue-router";
import { api } from "@/composables/useApi";
import { toErrorMessage } from "@/utils/errors";
import { tk } from "@/i18n";
import type { BundleDetail, BundleToolRef } from "@/types/api";
import BundleToolPicker from "@/components/BundleToolPicker.vue";
import PageHeader from "@/components/ui/PageHeader.vue";
import FormField from "@/components/ui/FormField.vue";
import FormPage from "@/components/ui/FormPage.vue";

const { t } = useI18n({ useScope: "global" });

const router = useRouter();

const name = ref("");
const description = ref("");
const tools = ref<BundleToolRef[]>([]);
const creating = ref(false);
const error = ref("");

async function createBundle() {
  error.value = "";
  if (!name.value.trim()) {
    error.value = t("pages.bundles.new.errors.name_required");
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
    error.value = toErrorMessage(err, tk("pages.bundles.new.errors.create_failed"));
  } finally {
    creating.value = false;
  }
}
</script>

<template>
  <section>
    <FormPage max-width="50rem">
      <PageHeader :title="t('pages.bundles.new.title')" :back-link="{ to: '/bundles', label: t('nav.bundles') }" />
      <p class="subtitle">
        {{ t("pages.bundles.new.subtitle_p1") }} <code>/mcp-custom/&lt;name&gt;</code>
        {{ t("pages.bundles.new.subtitle_p2") }}
      </p>

      <form class="form-card" @submit.prevent="createBundle">
        <FormField :label="t('pages.bundles.new.fields.name')" for="new-bundle-name">
          <input
            id="new-bundle-name"
            v-model="name"
            type="text"
            :placeholder="t('pages.bundles.new.placeholders.name')"
            required
          />
        </FormField>
        <p v-if="error" class="error">{{ error }}</p>
        <FormField :label="t('pages.bundles.new.fields.description')" for="new-bundle-description">
          <input
            id="new-bundle-description"
            v-model="description"
            type="text"
            :placeholder="t('pages.bundles.new.placeholders.description')"
          />
        </FormField>
        <div class="field">
          <label>{{ t("pages.bundles.new.fields.tools") }}</label>
          <BundleToolPicker v-model="tools" />
        </div>
        <button type="submit" class="btn-primary" :disabled="creating">
          {{ creating ? t("common.creating") : t("pages.bundles.create") }}
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
.field label {
  display: block;
  font-size: 0.85rem;
  font-weight: 600;
  margin-bottom: 0.3rem;
}
</style>
