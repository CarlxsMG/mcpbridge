<script setup lang="ts">
import { ref } from "vue";
import { useI18n } from "vue-i18n";
import { usePatchTool } from "@/composables/usePatchTool";
import { useFlash } from "@/composables/useFlash";
import { usePropDraft } from "@/composables/useFieldDraft";
import SaveRow from "@/components/ui/SaveRow.vue";
import { parseList } from "@/utils/fieldParsing";
import { tk } from "@/i18n";

const props = defineProps<{ tags?: string[]; clientName?: string; toolName?: string }>();
const emit = defineEmits<{ saved: [] }>();
const { t } = useI18n({ useScope: "global" });

const tagsInput = usePropDraft(() => (props.tags ?? []).join(", "));
const saved = ref(false);

const { saving, error, putTags } = usePatchTool(
  () => props.clientName ?? "",
  () => props.toolName,
);
const { flash } = useFlash();

async function saveTagsFn() {
  const ok = await putTags(parseList(tagsInput.value), tk("components.guard_editor_tags.errors.save_failed"));
  if (ok) {
    flash(saved);
    emit("saved");
  }
}
</script>

<template>
  <h3>{{ t("components.guard_editor_tags.title") }}</h3>
  <div class="field">
    <label for="tool-tags">{{ t("components.guard_editor_tags.label") }}</label>
    <p class="hint">{{ t("components.guard_editor_tags.hint") }}</p>
    <input
      id="tool-tags"
      v-model="tagsInput"
      type="text"
      :placeholder="t('components.guard_editor_tags.placeholder')"
      @keydown.enter.prevent
    />
    <SaveRow
      :label="t('components.guard_editor_tags.save')"
      :saving="saving"
      :saved="saved"
      :error="error"
      @save="saveTagsFn"
    />
  </div>
</template>
