<script setup lang="ts">
import { ref, watch } from "vue";
import { usePatchTool } from "@/composables/usePatchTool";
import { useFlash } from "@/composables/useFlash";

const props = defineProps<{
  graphql?: { enabled: boolean; query: string };
  clientName?: string;
  toolName?: string;
}>();
const emit = defineEmits<{ saved: [] }>();

const graphqlEnabledInput = ref(Boolean(props.graphql?.enabled));
const graphqlQueryInput = ref(props.graphql?.query ?? "");
const saved = ref(false);

watch(
  () => props.graphql,
  (g) => {
    graphqlEnabledInput.value = Boolean(g?.enabled);
    graphqlQueryInput.value = g?.query ?? "";
  },
);

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
      ><input v-model="graphqlEnabledInput" type="checkbox" /> Dispatch this tool as a GraphQL query/mutation instead
      of a plain REST body</label
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
    <button
      type="button"
      class="btn-secondary desc-save"
      :disabled="saving || (graphqlEnabledInput && !graphqlQueryInput.trim())"
      @click="saveGraphqlFn"
    >
      {{ saving ? "Saving…" : "Save GraphQL settings" }}
    </button>
    <span v-if="saved" class="save-ok">Saved</span>
    <p v-if="error" class="field-error">{{ error }}</p>
  </div>
</template>
