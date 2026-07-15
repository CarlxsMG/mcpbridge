<script setup lang="ts">
import { ref } from "vue";
import { useI18n } from "vue-i18n";
import { api } from "@/composables/useApi";
import { usePatchTool } from "@/composables/usePatchTool";
import { useFlash } from "@/composables/useFlash";
import { Eraser } from "lucide-vue-next";
import { tk } from "@/i18n";

const props = defineProps<{ clientName?: string; toolName?: string }>();
const { t } = useI18n({ useScope: "global" });

const {
  saving: purgingCache,
  error: purgeCacheError,
  run,
} = usePatchTool(
  () => props.clientName ?? "",
  () => props.toolName,
);
const purgedCache = ref(false);
const { flash } = useFlash();

async function purgeCacheFn() {
  const ok = await run(
    (path) => api.post(`${path}/cache/purge`),
    tk("components.guard_editor_cache_purge.errors.purge_failed"),
  );
  if (ok) flash(purgedCache);
}
</script>

<template>
  <h3>{{ t("components.guard_editor_cache_purge.title") }}</h3>
  <div class="field">
    <p class="hint">
      {{ t("components.guard_editor_cache_purge.hint") }}
    </p>
    <button
      type="button"
      class="btn-secondary desc-save"
      :disabled="purgingCache || !clientName || !toolName"
      @click="purgeCacheFn"
    >
      <Eraser :size="14" stroke-width="2" aria-hidden="true" />
      {{
        purgingCache
          ? t("components.guard_editor_cache_purge.purging")
          : t("components.guard_editor_cache_purge.button")
      }}
    </button>
    <span v-if="purgedCache" class="save-ok" role="status">{{ t("components.guard_editor_cache_purge.purged") }}</span>
    <p v-if="purgeCacheError" class="field-error" role="alert">{{ purgeCacheError }}</p>
  </div>
</template>
