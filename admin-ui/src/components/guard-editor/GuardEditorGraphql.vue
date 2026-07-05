<script setup lang="ts">
import { ref } from "vue";
import { useI18n } from "vue-i18n";
import { usePatchTool } from "@/composables/usePatchTool";
import { useFlash } from "@/composables/useFlash";
import { usePropDraft } from "@/composables/useFieldDraft";
import SaveRow from "@/components/ui/SaveRow.vue";
import { tk } from "@/i18n";

const props = defineProps<{
  graphql?: { enabled: boolean; query: string };
  clientName?: string;
  toolName?: string;
}>();
const emit = defineEmits<{ saved: [] }>();
const { t } = useI18n({ useScope: "global" });

const graphqlEnabledInput = usePropDraft(() => Boolean(props.graphql?.enabled));
const graphqlQueryInput = usePropDraft(() => props.graphql?.query ?? "");
const saved = ref(false);

const { saving, error, patchField } = usePatchTool(
  () => props.clientName ?? "",
  () => props.toolName,
);
const { flash } = useFlash();

async function saveGraphqlFn() {
  if (!graphqlEnabledInput.value) {
    const ok = await patchField("graphql", null, tk("components.guard_editor_graphql.errors.save_failed"));
    if (ok) {
      flash(saved);
      emit("saved");
    }
    return;
  }
  if (!graphqlQueryInput.value.trim()) return;
  const ok = await patchField(
    "graphql",
    { enabled: true, query: graphqlQueryInput.value.trim() },
    tk("components.guard_editor_graphql.errors.save_failed"),
  );
  if (ok) {
    flash(saved);
    emit("saved");
  }
}
</script>

<template>
  <h3>{{ t('components.guard_editor_graphql.title') }}</h3>
  <div class="field">
    <label class="checkline"
      ><input v-model="graphqlEnabledInput" type="checkbox" /> {{ t('components.guard_editor_graphql.enable_label') }}</label
    >
    <template v-if="graphqlEnabledInput">
      <label for="graphql-query">{{ t('components.guard_editor_graphql.query_label') }}</label>
      <textarea
        id="graphql-query"
        v-model="graphqlQueryInput"
        rows="6"
        spellcheck="false"
        placeholder="query my_tool($id: ID!) { pet(id: $id) { id name } }"
      ></textarea>
      <p class="hint">
        {{ t('components.guard_editor_graphql.hint_p1') }}
        <code>$var: Type</code>
        {{ t('components.guard_editor_graphql.hint_p2') }}
      </p>
    </template>
    <SaveRow :label="t('components.guard_editor_graphql.save')" :saving="saving" :saved="saved" :error="error" @save="saveGraphqlFn" />
  </div>
</template>