<script setup lang="ts">
import { ref } from "vue";
import { usePatchTool } from "@/composables/usePatchTool";
import { useFlash } from "@/composables/useFlash";
import { usePropDraft } from "@/composables/useFieldDraft";
import SaveRow from "@/components/ui/SaveRow.vue";

const props = defineProps<{
  graphql?: { enabled: boolean; query: string };
  clientName?: string;
  toolName?: string;
}>();
const emit = defineEmits<{ saved: [] }>();

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
    const ok = await patchField("graphql", null, "Failed to save GraphQL settings.");
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
    "Failed to save GraphQL settings.",
  );
  if (ok) {
    flash(saved);
    emit("saved");
  }
}
</script>

<template>
  <h3>GraphQL backend</h3>
  <div class="field">
    <label class="checkline"
      ><input v-model="graphqlEnabledInput" type="checkbox" /> Dispatch this tool as a GraphQL query/mutation instead of
      a plain REST body</label
    >
    <template v-if="graphqlEnabledInput">
      <label for="graphql-query">GraphQL query/mutation</label>
      <textarea
        id="graphql-query"
        v-model="graphqlQueryInput"
        rows="6"
        spellcheck="false"
        placeholder="query my_tool($id: ID!) { pet(id: $id) { id name } }"
      ></textarea>
      <p class="hint">
        Tool-call arguments are sent as GraphQL variables — declare a <code>$var: Type</code> for each argument this
        tool's input schema accepts. Auto-discovered tools start with a synthesized query you can extend here (e.g.
        deeper selection sets).
      </p>
    </template>
    <SaveRow label="Save GraphQL settings" :saving="saving" :saved="saved" :error="error" @save="saveGraphqlFn" />
  </div>
</template>
