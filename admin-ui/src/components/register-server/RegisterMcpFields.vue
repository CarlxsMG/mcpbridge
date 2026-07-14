<script setup lang="ts">
import { useI18n } from "vue-i18n";
import type { McpTransport } from "@/types/api";
import FormField from "@/components/ui/FormField.vue";
import SelectMenu from "@/components/ui/SelectMenu.vue";

const { t } = useI18n({ useScope: "global" });

const TRANSPORT_OPTIONS: { value: McpTransport; label: string }[] = [
  { value: "streamable-http", label: "Streamable HTTP" },
  { value: "sse", label: "SSE (legacy)" },
];

// Owned by the parent (read in register); exposed as models.
const mcpUrl = defineModel<string>("mcpUrl", { required: true });
const mcpTransport = defineModel<McpTransport>("mcpTransport", { required: true });
</script>

<template>
  <FormField :label="t('pages.register_server.mcp_url_label')" for="r-mcp-url">
    <input
      id="r-mcp-url"
      v-model="mcpUrl"
      type="url"
      required
      :placeholder="t('pages.register_server.mcp_url_placeholder')"
    />
  </FormField>
  <FormField :label="t('pages.register_server.mcp_transport_label')" for="r-mcp-transport">
    <SelectMenu id="r-mcp-transport" v-model="mcpTransport" :options="TRANSPORT_OPTIONS" />
  </FormField>
  <p class="hint">
    {{ t("pages.register_server.mcp_transport_hint") }}
  </p>
</template>

<style scoped>
.hint {
  font-size: 0.82rem;
  color: var(--text-secondary);
  margin: 0;
}
</style>
