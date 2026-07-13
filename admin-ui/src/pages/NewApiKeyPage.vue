<script setup lang="ts">
import { ref, computed, onMounted } from "vue";
import { useI18n } from "vue-i18n";
import { api } from "@/composables/useApi";
import { useClipboard } from "@/composables/useClipboard";
import { useCreateForm } from "@/composables/useCreateForm";
import { parseList } from "@/utils/fieldParsing";
import type { McpApiKeyWithSecret, Consumer } from "@/types/api";
import PageHeader from "@/components/ui/PageHeader.vue";
import FormField from "@/components/ui/FormField.vue";
import SelectMenu from "@/components/ui/SelectMenu.vue";
import FormPage from "@/components/ui/FormPage.vue";
import FieldError from "@/components/ui/FieldError.vue";
import SecretReveal from "@/components/ui/SecretReveal.vue";

const { t } = useI18n({ useScope: "global" });

const label = ref("");
const clients = ref("");
const tools = ref("");
const expires = ref("");
const consumerId = ref<number | "">("");
const elevated = ref(false);
const consumers = ref<Consumer[]>([]);
const consumerOptions = computed(() => [
  { value: "" as const, label: t("pages.keys.new.consumer_none") },
  ...consumers.value.map((c) => ({ value: c.id, label: c.name })),
]);

async function loadConsumers() {
  try {
    consumers.value = (await api.get<{ items: Consumer[] }>("/admin-api/consumers")).items;
  } catch {
    consumers.value = [];
  }
}
onMounted(loadConsumers);

const mintedKey = ref<McpApiKeyWithSecret | null>(null);
const { copied, copy } = useClipboard();

const { creating, error, run } = useCreateForm({
  submit: async () => {
    mintedKey.value = await api.post<McpApiKeyWithSecret>("/admin-api/mcp-keys", {
      label: label.value.trim(),
      scopes:
        parseList(clients.value).length || parseList(tools.value).length
          ? { clients: parseList(clients.value), tools: parseList(tools.value) }
          : null,
      expiresAt: expires.value ? new Date(expires.value).getTime() : null,
      consumerId: consumerId.value === "" ? null : consumerId.value,
      elevated: elevated.value,
    });
  },
  fallbackKey: "pages.keys.new.errors.create_failed",
});

function createKey() {
  return run(() => (label.value.trim() ? null : t("pages.keys.new.errors.label_required")));
}

async function copyKey() {
  if (!mintedKey.value) return;
  await copy(mintedKey.value.key);
}
</script>

<template>
  <section>
    <FormPage max-width="32rem">
      <PageHeader :title="t('pages.keys.new.title')" :back-link="{ to: '/keys', label: t('nav.keys.label') }" />

      <SecretReveal
        v-if="mintedKey"
        :title="t('pages.keys.new.minted_title', { label: mintedKey.label })"
        :secret="mintedKey.key"
      >
        <button type="button" class="btn-secondary" @click="copyKey">
          {{ copied ? t("common.copied") : t("common.copy") }}
        </button>
        <template #footer>
          <RouterLink to="/keys" class="btn-primary done-link">{{ t("common.done") }}</RouterLink>
        </template>
      </SecretReveal>

      <form v-else class="form-card" @submit.prevent="createKey">
        <FormField :label="t('pages.keys.new.fields.label')" for="k-label">
          <input
            id="k-label"
            v-model="label"
            type="text"
            required
            :placeholder="t('pages.keys.new.placeholders.label')"
          />
          <FieldError :message="error" />
        </FormField>
        <FormField :label="t('pages.keys.new.fields.clients')" for="k-clients">
          <input id="k-clients" v-model="clients" type="text" :placeholder="t('pages.keys.new.placeholders.clients')" />
        </FormField>
        <FormField :label="t('pages.keys.new.fields.tools')" for="k-tools">
          <input id="k-tools" v-model="tools" type="text" :placeholder="t('pages.keys.new.placeholders.tools')" />
        </FormField>
        <FormField :label="t('pages.keys.new.fields.expires')" for="k-expires">
          <input id="k-expires" v-model="expires" type="datetime-local" />
        </FormField>
        <FormField :label="t('pages.keys.new.fields.consumer')" for="k-consumer">
          <SelectMenu
            id="k-consumer"
            v-model="consumerId"
            :options="consumerOptions"
            create-path="/consumers/new"
            :create-label="t('pages.keys.new.create_consumer')"
            :reload="loadConsumers"
          />
        </FormField>
        <label class="checkbox-field"
          ><input v-model="elevated" type="checkbox" /> {{ t("pages.keys.new.elevated_label") }}</label
        >
        <button type="submit" class="btn-primary" :disabled="creating">
          {{ creating ? t("pages.keys.new.minting") : t("pages.keys.new.mint_key") }}
        </button>
      </form>
    </FormPage>
  </section>
</template>

<style scoped>
.done-link {
  display: inline-block;
}
.checkbox-field {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  font-size: 0.85rem;
  font-weight: 600;
  margin-bottom: 1rem;
}
.checkbox-field input {
  width: auto;
}
</style>
