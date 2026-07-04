<script setup lang="ts">
import { ref } from "vue";
import { useRouter } from "vue-router";
import { api } from "@/composables/useApi";
import { parseOptionalNumber } from "@/utils/fieldParsing";
import { toErrorMessage } from "@/utils/errors";
import PageHeader from "@/components/ui/PageHeader.vue";
import FormField from "@/components/ui/FormField.vue";
import FormPage from "@/components/ui/FormPage.vue";

const router = useRouter();

const name = ref("");
const backendUrl = ref("");
const maxConnections = ref("");
const maxMessageBytes = ref("");
const idleTimeoutMinutes = ref("");
const error = ref("");
const creating = ref(false);

async function createTarget() {
  error.value = "";
  if (!name.value.trim() || !backendUrl.value.trim()) {
    error.value = "Name and backend WebSocket URL are required.";
    return;
  }
  const maxConnectionsResult = parseOptionalNumber(
    maxConnections.value,
    "Max connections must be a plain number, or blank.",
  );
  const maxMessageBytesResult = parseOptionalNumber(
    maxMessageBytes.value,
    "Max message size must be a plain number, or blank.",
  );
  const idleTimeoutMinutesResult = parseOptionalNumber(
    idleTimeoutMinutes.value,
    "Idle timeout must be a plain number, or blank.",
  );
  for (const result of [maxConnectionsResult, maxMessageBytesResult, idleTimeoutMinutesResult]) {
    if (result.error) {
      error.value = result.error;
      return;
    }
  }
  creating.value = true;
  try {
    const body: Record<string, unknown> = { name: name.value.trim(), backendWsUrl: backendUrl.value.trim() };
    if (maxConnectionsResult.value !== null) body.maxConnections = maxConnectionsResult.value;
    if (maxMessageBytesResult.value !== null) body.maxMessageBytes = maxMessageBytesResult.value;
    if (idleTimeoutMinutesResult.value !== null) body.idleTimeoutMs = idleTimeoutMinutesResult.value * 60_000;
    await api.post("/admin-api/ws-proxy-targets", body);
    await router.push("/ws-proxies");
  } catch (err) {
    error.value = toErrorMessage(err, "Failed to create target.");
  } finally {
    creating.value = false;
  }
}
</script>

<template>
  <section>
    <FormPage max-width="26.25rem">
      <PageHeader title="New WS proxy target" :back-link="{ to: '/ws-proxies', label: 'WS proxies' }" />

      <form class="create-form" @submit.prevent="createTarget">
        <FormField label="Name" for="wp-name">
          <input id="wp-name" v-model="name" type="text" placeholder="iot-gateway" />
        </FormField>
        <FormField label="Backend WebSocket URL" for="wp-url">
          <input id="wp-url" v-model="backendUrl" type="text" placeholder="wss://backend.example.com/socket" />
        </FormField>
        <FormField label="Max concurrent connections (blank = default)" for="wp-max-conn">
          <input id="wp-max-conn" v-model="maxConnections" type="text" inputmode="numeric" />
        </FormField>
        <FormField label="Max message size, bytes (blank = default)" for="wp-max-bytes">
          <input id="wp-max-bytes" v-model="maxMessageBytes" type="text" inputmode="numeric" />
        </FormField>
        <FormField label="Idle timeout, minutes (blank = default)" for="wp-idle">
          <input id="wp-idle" v-model="idleTimeoutMinutes" type="text" inputmode="numeric" />
        </FormField>
        <p v-if="error" class="error">{{ error }}</p>
        <button type="submit" class="btn-primary" :disabled="creating">
          {{ creating ? "Creating…" : "Create target" }}
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
