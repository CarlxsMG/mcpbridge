<script setup lang="ts">
/**
 * Read-only view of the environment the gateway resolved at boot.
 *
 * Collapsed by default: it is ~115 rows, and it answers a question you only ask
 * when something is behaving unexpectedly ("which timeout is actually in
 * force?", "is ALLOW_PRIVATE_IPS on here?"). Expanding is one click; having it
 * open by default would bury the three action cards this page exists for.
 */
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { api } from "@/composables/useApi";
import { useResource } from "@/composables/useResource";
import type { EffectiveConfig } from "@/types/api";
import ListLayout from "@/components/ui/ListLayout.vue";
import SearchInput from "@/components/ui/SearchInput.vue";
import CopyButton from "@/components/ui/CopyButton.vue";
import { tk } from "@/i18n";

const { t } = useI18n({ useScope: "global" });

const open = ref(false);
const filter = ref("");

const {
  data: effective,
  loading,
  errorMessage,
  errorRequestId,
  load,
} = useResource<EffectiveConfig | null>(
  () => api.get<EffectiveConfig>("/admin-api/config/effective"),
  null,
  tk("components.config_effective.errors.load_failed"),
);

function toggle() {
  open.value = !open.value;
  // Fetched on first expand rather than on mount: no reason to spend a request
  // on a panel most visits never open.
  if (open.value && effective.value === null) void load();
}

const rows = computed(() => {
  const entries = effective.value?.entries ?? [];
  const q = filter.value.trim().toLowerCase();
  if (!q) return entries;
  return entries.filter((e) => e.key.toLowerCase().includes(q));
});

/**
 * Renders a value for display. Arrays and objects go through JSON so an
 * allowlist or a parsed CORS origin list is readable rather than "[object
 * Object]"; `undefined` becomes an explicit marker so "not set" is never
 * confusable with an empty string.
 */
function display(value: unknown): string {
  if (value === undefined) return "—";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

/** The whole resolved config as text, for pasting into an issue or diffing two instances. */
const asText = computed(() => (effective.value?.entries ?? []).map((e) => `${e.key}=${display(e.value)}`).join("\n"));
</script>

<template>
  <div class="config-block">
    <h2>
      <button type="button" class="disclosure" :aria-expanded="open" @click="toggle">
        {{ t("components.config_effective.title") }}
        <span aria-hidden="true">{{ open ? "▾" : "▸" }}</span>
      </button>
    </h2>
    <p class="hint">{{ t("components.config_effective.hint") }}</p>

    <template v-if="open">
      <div class="toolbar">
        <SearchInput v-model="filter" :placeholder="t('components.config_effective.filter_placeholder')" />
        <CopyButton v-if="effective" :text="asText" :label="t('components.config_effective.copy_all')" />
      </div>

      <ListLayout
        :loading="loading"
        :error="errorMessage"
        :error-request-id="errorRequestId"
        :empty="rows.length === 0"
      >
        <template #empty>
          <p class="hint">{{ t("components.config_effective.no_matches", { filter }) }}</p>
        </template>
        <p class="node-env">
          {{ t("components.config_effective.node_env") }} <code>{{ effective?.nodeEnv }}</code>
        </p>
        <table>
          <thead>
            <tr>
              <th scope="col">{{ t("components.config_effective.table.key") }}</th>
              <th scope="col">{{ t("components.config_effective.table.value") }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="entry in rows" :key="entry.key">
              <td>
                <code>{{ entry.key }}</code>
              </td>
              <td>
                <template v-if="entry.redacted">
                  <span class="redacted">{{
                    entry.value === "set"
                      ? t("components.config_effective.redacted_set")
                      : t("components.config_effective.redacted_unset")
                  }}</span>
                </template>
                <code v-else class="value">{{ display(entry.value) }}</code>
              </td>
            </tr>
          </tbody>
        </table>
      </ListLayout>
    </template>
  </div>
</template>

<style scoped>
.disclosure {
  background: none;
  border: none;
  padding: 0;
  font: inherit;
  color: inherit;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
}
.toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-3);
  margin: 0.75rem 0;
}
.node-env {
  margin: 0 0 0.5rem;
  font-size: 0.85rem;
  color: var(--text-secondary);
}
table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.85rem;
}
th {
  text-align: left;
  border-bottom: 1px solid var(--border);
  padding: var(--table-pad-y, 0.45rem) 0.5rem;
}
td {
  border-bottom: 1px solid var(--border);
  padding: var(--table-pad-y, 0.45rem) 0.5rem;
  vertical-align: top;
}
/* Long values (CORS origin lists, allowed-host arrays) must wrap inside the
   cell rather than push the page into a horizontal scroll. */
td .value {
  overflow-wrap: anywhere;
}
.redacted {
  font-size: var(--text-xs);
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.03em;
  color: var(--text-muted);
}
</style>
