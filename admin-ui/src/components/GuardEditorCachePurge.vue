<script setup lang="ts">
import { ref } from "vue";
import { api } from "../composables/useApi";
import { usePatchTool } from "../composables/usePatchTool";
import { useFlash } from "../composables/useFlash";
import { Eraser } from "lucide-vue-next";

const props = defineProps<{ clientName?: string; toolName?: string }>();

const { saving: purgingCache, error: purgeCacheError, run } = usePatchTool(
  () => props.clientName ?? "",
  () => props.toolName,
);
const purgedCache = ref(false);
const { flash } = useFlash();

async function purgeCacheFn() {
  const ok = await run((path) => api.post(`${path}/cache/purge`), "Failed to purge cache.");
  if (ok) flash(purgedCache);
}
</script>

<template>
  <h3>Response cache</h3>
  <div class="field">
    <p class="hint">
      Clears any responses already cached for this tool. Doesn't change the cache's enabled/TTL config — new responses
      are cached again on the next matching call.
    </p>
    <button
      type="button"
      class="btn-secondary desc-save"
      :disabled="purgingCache || !clientName || !toolName"
      @click="purgeCacheFn"
    >
      <Eraser :size="14" stroke-width="2" aria-hidden="true" />
      {{ purgingCache ? "Purging…" : "Purge cached responses" }}
    </button>
    <span v-if="purgedCache" class="save-ok">Purged</span>
    <p v-if="purgeCacheError" class="field-error">{{ purgeCacheError }}</p>
  </div>
</template>
