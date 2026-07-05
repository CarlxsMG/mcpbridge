<script setup lang="ts">
import { ref, computed, onMounted } from "vue";
import { api } from "@/composables/useApi";
import { useClipboard } from "@/composables/useClipboard";
import { toErrorMessage } from "@/utils/errors";
import { parseList } from "@/utils/fieldParsing";
import type { McpApiKeyWithSecret, Consumer } from "@/types/api";
import PageHeader from "@/components/ui/PageHeader.vue";
import FormField from "@/components/ui/FormField.vue";
import SelectMenu from "@/components/ui/SelectMenu.vue";
import FormPage from "@/components/ui/FormPage.vue";

const label = ref("");
const clients = ref("");
const tools = ref("");
const expires = ref("");
const consumerId = ref<number | "">("");
const elevated = ref(false);
const consumers = ref<Consumer[]>([]);
const consumerOptions = computed(() => [
  { value: "" as const, label: "None" },
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

const creating = ref(false);
const error = ref("");
const mintedKey = ref<McpApiKeyWithSecret | null>(null);
const { copied, copy } = useClipboard();

async function createKey() {
  error.value = "";
  if (!label.value.trim()) {
    error.value = "A label is required.";
    return;
  }
  const clientList = parseList(clients.value);
  const toolList = parseList(tools.value);
  const scopes = clientList.length || toolList.length ? { clients: clientList, tools: toolList } : null;
  const expiresAt = expires.value ? new Date(expires.value).getTime() : null;

  creating.value = true;
  try {
    mintedKey.value = await api.post<McpApiKeyWithSecret>("/admin-api/mcp-keys", {
      label: label.value.trim(),
      scopes,
      expiresAt,
      consumerId: consumerId.value === "" ? null : consumerId.value,
      elevated: elevated.value,
    });
  } catch (err) {
    error.value = toErrorMessage(err, "Failed to create API key.");
  } finally {
    creating.value = false;
  }
}

async function copyKey() {
  if (!mintedKey.value) return;
  await copy(mintedKey.value.key);
}
</script>

<template>
  <section>
    <FormPage max-width="32rem">
      <PageHeader title="Mint API key" :back-link="{ to: '/keys', label: 'API keys' }" />

      <div v-if="mintedKey" class="minted" role="alert">
        <div class="minted-title">New key "{{ mintedKey.label }}" — copy it now, it won't be shown again:</div>
        <div class="minted-row">
          <code class="minted-secret">{{ mintedKey.key }}</code>
          <button type="button" class="btn-secondary" @click="copyKey">{{ copied ? "Copied" : "Copy" }}</button>
        </div>
        <RouterLink to="/keys" class="btn-primary done-link">Done</RouterLink>
      </div>

      <form v-else class="form-card" @submit.prevent="createKey">
        <FormField label="Label" for="k-label">
          <input id="k-label" v-model="label" type="text" required placeholder="e.g. ci-bot" />
          <p v-if="error" class="error">{{ error }}</p>
        </FormField>
        <FormField label="Allowed clients (comma-separated, blank = all)" for="k-clients">
          <input id="k-clients" v-model="clients" type="text" placeholder="payments-svc, inventory-svc" />
        </FormField>
        <FormField label="Allowed tools (comma-separated client__tool)" for="k-tools">
          <input id="k-tools" v-model="tools" type="text" placeholder="payments-svc__charge" />
        </FormField>
        <FormField label="Expires (optional)" for="k-expires">
          <input id="k-expires" v-model="expires" type="datetime-local" />
        </FormField>
        <FormField label="Consumer (optional)" for="k-consumer">
          <SelectMenu
            id="k-consumer"
            v-model="consumerId"
            :options="consumerOptions"
            create-path="/consumers/new"
            create-label="Create consumer"
            :reload="loadConsumers"
          />
        </FormField>
        <label class="checkbox-field"
          ><input v-model="elevated" type="checkbox" /> Elevated (bypasses sensitive-tool confirmation)</label
        >
        <button type="submit" class="btn-primary" :disabled="creating">
          {{ creating ? "Minting…" : "Mint key" }}
        </button>
      </form>
    </FormPage>
  </section>
</template>

<style scoped>
.minted {
  background: var(--ok-soft);
  border: 1px solid var(--ok);
  border-radius: var(--radius-md);
  padding: 1rem;
}
.minted-title {
  font-weight: 600;
  font-size: 0.85rem;
  margin-bottom: 0.5rem;
}
.minted-row {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  flex-wrap: wrap;
  margin-bottom: 1rem;
}
.minted-secret {
  background: var(--surface);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  padding: 0.4rem 0.6rem;
  font-size: 0.85rem;
  font-family: var(--font-mono);
  word-break: break-all;
  flex: 1;
  min-width: 12.5rem;
}
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
