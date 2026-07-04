<script setup lang="ts">
import { ref, computed, onMounted } from "vue";
import { Combine } from "lucide-vue-next";
import { api } from "@/composables/useApi";
import { useResource } from "@/composables/useResource";
import { useConfirmAction } from "@/composables/useConfirmAction";
import { useOptimisticToggle } from "@/composables/useOptimisticToggle";
import { useEntityForm } from "@/composables/useEntityForm";
import { toErrorMessage } from "@/utils/errors";
import type { CompositeSummary, CompositeDetail, CompositeStep } from "@/types/api";
import ConfirmDialog from "@/components/ui/ConfirmDialog.vue";
import PageHeader from "@/components/ui/PageHeader.vue";
import ListLayout from "@/components/ui/ListLayout.vue";
import TableCard from "@/components/ui/TableCard.vue";
import EmptyState from "@/components/ui/EmptyState.vue";
import FormField from "@/components/ui/FormField.vue";
import ToggleFormButton from "@/components/ui/ToggleFormButton.vue";
import TogglePill from "@/components/ui/TogglePill.vue";
import HoverPreview from "@/components/ui/HoverPreview.vue";

const {
  data: items,
  loading,
  errorMessage,
  load,
} = useResource<CompositeSummary[]>(
  async () => (await api.get<{ items: CompositeSummary[] }>("/admin-api/composites")).items,
  [],
  "Failed to load composites.",
);
const rowError = ref<Record<string, string>>({});
const { rowError: toggleError, toggle } = useOptimisticToggle<CompositeSummary>((c) => c.name, "Failed to update.");

const newName = ref("");
const newNameTouched = ref(false);
const newDescription = ref("");
const newSchema = ref('{\n  "type": "object",\n  "properties": {}\n}');
const newSteps = ref(
  '[\n  { "targetClient": "docs", "targetTool": "search", "argsTemplate": { "query": "${input.query}" } },\n  { "targetClient": "docs", "targetTool": "get", "argsTemplate": { "id": { "$ref": "steps.0.json.id" } } }\n]',
);
const schemaError = ref("");
const stepsError = ref("");

const newNameError = computed(() => {
  const v = newName.value.trim();
  if (!v) return null;
  return /^[a-z0-9][a-z0-9_-]{0,62}$/.test(v) && !v.includes("__")
    ? null
    : "Lowercase letters, digits, - and _ (max 63 chars); must not contain '__'.";
});

function resetForm() {
  newName.value = "";
  newNameTouched.value = false;
  newDescription.value = "";
}

const { open: showCreateForm, busy: creating, error: createError, submit } = useEntityForm<void>({ reset: resetForm });

onMounted(load);

async function createComposite() {
  createError.value = "";
  schemaError.value = "";
  stepsError.value = "";
  newNameTouched.value = true;
  if (!newName.value.trim()) {
    createError.value = "Name is required.";
    return;
  }
  if (newNameError.value) {
    return;
  }
  let inputSchema: Record<string, unknown>;
  let steps: CompositeStep[];
  try {
    inputSchema = JSON.parse(newSchema.value) as Record<string, unknown>;
  } catch {
    schemaError.value = "inputSchema is not valid JSON.";
    return;
  }
  try {
    steps = JSON.parse(newSteps.value) as CompositeStep[];
  } catch {
    stepsError.value = "steps is not valid JSON.";
    return;
  }
  const ok = await submit(async () => {
    await api.post<CompositeDetail>("/admin-api/composites", {
      name: newName.value.trim(),
      description: newDescription.value.trim() || undefined,
      inputSchema,
      steps,
    });
  }, "Failed to create composite.");
  if (ok) await load();
}

function toggleEnabled(c: CompositeSummary) {
  toggle(c, "enabled", (next) => api.patch(`/admin-api/composites/${encodeURIComponent(c.name)}`, { enabled: next }));
}

const {
  pending: pendingDelete,
  request: requestDelete,
  cancel: cancelDelete,
  confirm: confirmDeleteAction,
} = useConfirmAction<CompositeSummary>();

function confirmDelete() {
  return confirmDeleteAction(async (c) => {
    delete rowError.value[c.name];
    try {
      await api.delete(`/admin-api/composites/${encodeURIComponent(c.name)}`);
      await load();
    } catch (err) {
      rowError.value[c.name] = toErrorMessage(err, "Failed to delete.");
    }
  });
}
</script>

<template>
  <section>
    <PageHeader title="Composite tools">
      <ToggleFormButton v-model="showCreateForm" show-label="New composite" />
    </PageHeader>
    <p class="subtitle">
      Chains several existing tool calls into one, exposed on the aggregated MCP endpoint. Each step forwards to a real
      <code>client__tool</code> through the full guard stack.
    </p>

    <form v-if="showCreateForm" class="create-form" @submit.prevent="createComposite">
      <FormField label="Name" for="new-composite-name">
        <input
          id="new-composite-name"
          v-model="newName"
          type="text"
          placeholder="lowercase, no '__'"
          required
          @blur="newNameTouched = true"
        />
        <p v-if="newNameTouched && newNameError" class="error">{{ newNameError }}</p>
      </FormField>
      <FormField label="Description" for="new-composite-description">
        <input id="new-composite-description" v-model="newDescription" type="text" placeholder="Optional" />
      </FormField>
      <FormField label="Input schema (JSON)" for="new-composite-schema">
        <textarea
          id="new-composite-schema"
          v-model="newSchema"
          class="mono-field"
          rows="4"
          spellcheck="false"
        ></textarea>
        <p v-if="schemaError" class="error">{{ schemaError }}</p>
      </FormField>
      <FormField label="Steps (JSON array)" for="new-composite-steps">
        <p class="template-hint">
          Templates: <code>{{ '{ "$ref": "steps.0.json.id" }' }}</code> or <code>{{ '"${input.query}"' }}</code
          >.
        </p>
        <textarea id="new-composite-steps" v-model="newSteps" class="mono-field" rows="6" spellcheck="false"></textarea>
        <p v-if="stepsError" class="error">{{ stepsError }}</p>
      </FormField>
      <p v-if="createError" class="error">{{ createError }}</p>
      <button class="btn-primary" type="submit" :disabled="creating">
        {{ creating ? "Creating…" : "Create composite" }}
      </button>
    </form>

    <ListLayout :loading="loading" :error="errorMessage" :empty="items.length === 0">
      <template #empty>
        <EmptyState :icon="Combine">
          No composite tools yet. A composite chains several existing tool calls into one, exposed on the aggregated MCP
          endpoint.
        </EmptyState>
      </template>

      <TableCard>
        <thead>
          <tr>
            <th>Name</th>
            <th>Description</th>
            <th>Steps</th>
            <th>Enabled</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="c in items" :key="c.name">
            <td>
              <RouterLink :to="`/composites/${encodeURIComponent(c.name)}`">{{ c.name }}</RouterLink>
            </td>
            <td>
              <HoverPreview class="desc-cell" :text="c.description ?? ''">{{ c.description || "—" }}</HoverPreview>
            </td>
            <td>{{ c.stepsCount }}</td>
            <td>
              <TogglePill
                :on="c.enabled"
                on-label="Disable composite"
                off-label="Enable composite"
                :aria-pressed="c.enabled"
                @click="toggleEnabled(c)"
              />
              <p v-if="toggleError[c.name]" class="row-error">{{ toggleError[c.name] }}</p>
            </td>
            <td><button type="button" class="link-btn danger" @click="requestDelete(c)">Delete</button></td>
          </tr>
        </tbody>
      </TableCard>
    </ListLayout>

    <ConfirmDialog
      :open="pendingDelete !== null"
      title="Delete this composite?"
      :message="
        pendingDelete
          ? `MCP clients calling '${pendingDelete.name}' will start failing immediately. This cannot be undone.`
          : ''
      "
      :confirm-label="pendingDelete ? `Delete ${pendingDelete.name}` : 'Delete'"
      danger
      @confirm="confirmDelete"
      @cancel="cancelDelete"
    />
  </section>
</template>

<style scoped>
.subtitle {
  color: var(--text-secondary);
  margin: 0 0 1.25rem;
  max-width: 35rem;
}
.create-form {
  background: var(--surface);
  border: 1px solid var(--border);
  padding: 1.25rem;
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-xs);
  margin-bottom: 1.5rem;
  max-width: 35rem;
  display: flex;
  flex-direction: column;
  gap: 0.8rem;
}
.field textarea.mono-field {
  font-family: var(--font-mono);
  font-size: 0.85rem;
}
.template-hint {
  color: var(--text-secondary);
  font-size: 0.82rem;
  margin: 0 0 0.4rem;
}
.desc-cell {
  color: var(--text-secondary);
  max-width: 20rem;
}
</style>
