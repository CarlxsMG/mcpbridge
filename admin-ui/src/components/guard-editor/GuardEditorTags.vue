<script setup lang="ts">
import { ref, watch } from "vue";
import { usePatchTool } from "@/composables/usePatchTool";
import { useFlash } from "@/composables/useFlash";
import { parseList } from "@/utils/fieldParsing";

const props = defineProps<{ tags?: string[]; clientName?: string; toolName?: string }>();
const emit = defineEmits<{ saved: [] }>();

const tagsInput = ref((props.tags ?? []).join(", "));
const saved = ref(false);

watch(
  () => props.tags,
  (t) => {
    tagsInput.value = (t ?? []).join(", ");
  },
);

const { saving, error, putTags } = usePatchTool(
  () => props.clientName ?? "",
  () => props.toolName,
);
const { flash } = useFlash();

async function saveTagsFn() {
  const ok = await putTags(parseList(tagsInput.value), "Failed to save tags.");
  if (ok) {
    flash(saved);
    emit("saved");
  }
}
</script>

<template>
  <h3>Tags</h3>
  <div class="field">
    <label for="tool-tags">Comma-separated tags</label>
    <p class="hint">Comma-separated (lowercase letters, digits, - and _). Used to organize and filter tools.</p>
    <input id="tool-tags" v-model="tagsInput" type="text" placeholder="billing, read-only" @keydown.enter.prevent />
    <button type="button" class="btn-secondary desc-save" :disabled="saving" @click="saveTagsFn">
      {{ saving ? "Saving…" : "Save tags" }}
    </button>
    <span v-if="saved" class="save-ok">Saved</span>
    <p v-if="error" class="field-error">{{ error }}</p>
  </div>
</template>
