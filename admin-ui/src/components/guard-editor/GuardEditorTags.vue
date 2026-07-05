<script setup lang="ts">
import { ref } from "vue";
import { usePatchTool } from "@/composables/usePatchTool";
import { useFlash } from "@/composables/useFlash";
import { usePropDraft } from "@/composables/useFieldDraft";
import SaveRow from "@/components/ui/SaveRow.vue";
import { parseList } from "@/utils/fieldParsing";

const props = defineProps<{ tags?: string[]; clientName?: string; toolName?: string }>();
const emit = defineEmits<{ saved: [] }>();

const tagsInput = usePropDraft(() => (props.tags ?? []).join(", "));
const saved = ref(false);

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
    <SaveRow label="Save tags" :saving="saving" :saved="saved" :error="error" @save="saveTagsFn" />
  </div>
</template>
