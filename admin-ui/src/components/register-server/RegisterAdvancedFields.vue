<script setup lang="ts">
/**
 * Everything the register form used to ask up front and now derives or defaults:
 * the client name, the health/base URLs, the OpenAPI filters, and the two
 * kind-specific options.
 *
 * Closed by default — a user who pasted an OpenAPI URL never has to open it.
 * The parent forces it open (via the `open` model) when derivation could not
 * fill a required field, so the disclosure can never hide the one input that is
 * blocking submission.
 */
import { useI18n } from "vue-i18n";
import type { McpTransport } from "@/types/api";
import type { RegisterKind, RegisterMode } from "@/utils/registerSource";
import FormField from "@/components/ui/FormField.vue";
import SelectMenu from "@/components/ui/SelectMenu.vue";

defineProps<{
  kind: RegisterKind;
  mode: RegisterMode;
  nameError?: string;
  healthUrlError?: string;
}>();

const open = defineModel<boolean>("open", { required: true });
const name = defineModel<string>("name", { required: true });
const healthUrl = defineModel<string>("healthUrl", { required: true });
const baseUrl = defineModel<string>("baseUrl", { required: true });
const includeTags = defineModel<string>("includeTags", { required: true });
const excludeOps = defineModel<string>("excludeOps", { required: true });
const mcpTransport = defineModel<McpTransport>("mcpTransport", { required: true });
const includeMutations = defineModel<boolean>("includeMutations", { required: true });

const { t } = useI18n({ useScope: "global" });

const TRANSPORT_OPTIONS: { value: McpTransport; label: string }[] = [
  { value: "streamable-http", label: "Streamable HTTP" },
  { value: "sse", label: "SSE (legacy)" },
];

// `<details>` owns its own open state once the user clicks the summary, so the
// model has to be written back from the element rather than only into it —
// otherwise the parent's "force open" would fight the user's next close.
function onToggle(event: Event) {
  const el = event.target;
  if (el instanceof HTMLDetailsElement) open.value = el.open;
}
</script>

<template>
  <details class="advanced" :open="open" @toggle="onToggle">
    <summary>{{ t("pages.register_server.advanced_summary") }}</summary>

    <FormField v-slot="field" :label="t('pages.register_server.name_label')" for="r-name" :error="nameError">
      <input
        id="r-name"
        v-model="name"
        type="text"
        :placeholder="t('pages.register_server.name_placeholder')"
        v-bind="field"
      />
    </FormField>

    <FormField
      v-if="kind !== 'mcp'"
      v-slot="field"
      :label="
        kind === 'graphql'
          ? t('pages.register_server.health_url_optional_label')
          : t('pages.register_server.health_url_label')
      "
      for="r-health"
      :error="healthUrlError"
    >
      <input
        id="r-health"
        v-model="healthUrl"
        type="url"
        :placeholder="t('pages.register_server.health_url_placeholder')"
        v-bind="field"
      />
      <p v-if="kind === 'graphql'" class="hint">{{ t("pages.register_server.graphql_health_hint") }}</p>
    </FormField>

    <FormField v-if="kind === 'rest'" :label="t('pages.register_server.base_url_label')" for="r-base">
      <input id="r-base" v-model="baseUrl" type="url" :placeholder="t('pages.register_server.base_url_placeholder')" />
    </FormField>

    <template v-if="kind === 'rest' && mode === 'openapi'">
      <FormField :label="t('pages.register_server.include_tags_label')" for="r-tags">
        <input
          id="r-tags"
          v-model="includeTags"
          type="text"
          :placeholder="t('pages.register_server.include_tags_placeholder')"
        />
      </FormField>
      <FormField :label="t('pages.register_server.exclude_ops_label')" for="r-exclude">
        <input
          id="r-exclude"
          v-model="excludeOps"
          type="text"
          :placeholder="t('pages.register_server.exclude_ops_placeholder')"
        />
      </FormField>
    </template>

    <FormField v-if="kind === 'mcp'" :label="t('pages.register_server.mcp_transport_label')" for="r-mcp-transport">
      <SelectMenu id="r-mcp-transport" v-model="mcpTransport" :options="TRANSPORT_OPTIONS" />
    </FormField>

    <label v-if="kind === 'graphql'" class="checkline"
      ><input v-model="includeMutations" type="checkbox" />
      {{ t("pages.register_server.graphql_include_mutations") }}</label
    >
  </details>
</template>

<style scoped>
.advanced {
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--surface-sunken);
  padding: var(--space-2) var(--space-3);
}
.advanced summary {
  cursor: pointer;
  font-size: 0.85rem;
  font-weight: 600;
  color: var(--text-secondary);
}
.advanced summary:hover {
  color: var(--text-primary);
}
.advanced[open] summary {
  margin-bottom: var(--space-3);
}
.hint {
  font-size: 0.82rem;
  color: var(--text-secondary);
  margin: 0.3rem 0 0;
}
.checkline {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  font-size: 0.85rem;
  font-weight: 600;
}
.checkline input {
  width: auto;
}
</style>
