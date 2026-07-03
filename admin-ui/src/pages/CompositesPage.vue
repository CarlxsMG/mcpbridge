<script setup lang="ts">
import { ref, computed, onMounted } from "vue";
import { Combine } from "lucide-vue-next";
import { api, ApiError } from "../composables/useApi";
import { useResource } from "../composables/useResource";
import type { CompositeSummary, CompositeDetail, CompositeStep } from "../types/api";
import ConfirmDialog from "../components/ConfirmDialog.vue";

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

const showCreateForm = ref(false);
const newName = ref("");
const newNameTouched = ref(false);
const newDescription = ref("");
const newSchema = ref('{\n  "type": "object",\n  "properties": {}\n}');
const newSteps = ref(
  '[\n  { "targetClient": "docs", "targetTool": "search", "argsTemplate": { "query": "${input.query}" } },\n  { "targetClient": "docs", "targetTool": "get", "argsTemplate": { "id": { "$ref": "steps.0.json.id" } } }\n]',
);
const createError = ref("");
const schemaError = ref("");
const stepsError = ref("");
const creating = ref(false);

const newNameError = computed(() => {
  const v = newName.value.trim();
  if (!v) return null;
  return /^[a-z0-9][a-z0-9_-]{0,62}$/.test(v) && !v.includes("__")
    ? null
    : "Lowercase letters, digits, - and _ (max 63 chars); must not contain '__'.";
});

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
  creating.value = true;
  try {
    await api.post<CompositeDetail>("/admin-api/composites", {
      name: newName.value.trim(),
      description: newDescription.value.trim() || undefined,
      inputSchema,
      steps,
    });
    newName.value = "";
    newDescription.value = "";
    newNameTouched.value = false;
    showCreateForm.value = false;
    await load();
  } catch (err) {
    createError.value = err instanceof ApiError ? err.message : "Failed to create composite.";
  } finally {
    creating.value = false;
  }
}

async function toggleEnabled(c: CompositeSummary) {
  const next = !c.enabled;
  const previous = c.enabled;
  c.enabled = next;
  delete rowError.value[c.name];
  try {
    await api.patch(`/admin-api/composites/${encodeURIComponent(c.name)}`, { enabled: next });
  } catch (err) {
    c.enabled = previous;
    rowError.value[c.name] = err instanceof ApiError ? err.message : "Failed to update.";
  }
}

const pendingDelete = ref<CompositeSummary | null>(null);

function requestDelete(c: CompositeSummary) {
  pendingDelete.value = c;
}

async function confirmDelete() {
  if (!pendingDelete.value) return;
  const c = pendingDelete.value;
  pendingDelete.value = null;
  delete rowError.value[c.name];
  try {
    await api.delete(`/admin-api/composites/${encodeURIComponent(c.name)}`);
    await load();
  } catch (err) {
    rowError.value[c.name] = err instanceof ApiError ? err.message : "Failed to delete.";
  }
}
</script>

<template>
  <section>
    <header class="page-header">
      <div>
        <h1>Composite tools</h1>
        <p class="subtitle">
          Chains several existing tool calls into one, exposed on the aggregated MCP endpoint. Each step forwards to a
          real <code>client__tool</code> through the full guard stack.
        </p>
      </div>
      <button
        type="button"
        :class="showCreateForm ? 'btn-secondary' : 'btn-primary'"
        @click="showCreateForm = !showCreateForm"
      >
        {{ showCreateForm ? "Cancel" : "New composite" }}
      </button>
    </header>

    <form v-if="showCreateForm" class="create-form" @submit.prevent="createComposite">
      <div class="field">
        <label for="new-composite-name">Name</label>
        <input
          id="new-composite-name"
          v-model="newName"
          type="text"
          placeholder="lowercase, no '__'"
          required
          @blur="newNameTouched = true"
        />
        <p v-if="newNameTouched && newNameError" class="error">{{ newNameError }}</p>
      </div>
      <div class="field">
        <label for="new-composite-description">Description</label>
        <input id="new-composite-description" v-model="newDescription" type="text" placeholder="Optional" />
      </div>
      <div class="field">
        <label for="new-composite-schema">Input schema (JSON)</label>
        <textarea
          id="new-composite-schema"
          v-model="newSchema"
          class="mono-field"
          rows="4"
          spellcheck="false"
        ></textarea>
        <p v-if="schemaError" class="error">{{ schemaError }}</p>
      </div>
      <div class="field">
        <label for="new-composite-steps">Steps (JSON array)</label>
        <p class="template-hint">
          Templates: <code>{{ '{ "$ref": "steps.0.json.id" }' }}</code> or <code>{{ '"${input.query}"' }}</code
          >.
        </p>
        <textarea id="new-composite-steps" v-model="newSteps" class="mono-field" rows="6" spellcheck="false"></textarea>
        <p v-if="stepsError" class="error">{{ stepsError }}</p>
      </div>
      <p v-if="createError" class="error">{{ createError }}</p>
      <button class="btn-primary" type="submit" :disabled="creating">
        {{ creating ? "Creating…" : "Create composite" }}
      </button>
    </form>

    <p v-if="errorMessage" class="error" role="alert">{{ errorMessage }}</p>
    <div v-if="loading" class="loading">Loading…</div>

    <template v-else-if="items.length === 0">
      <div class="empty-state">
        <Combine :size="26" stroke-width="1.5" aria-hidden="true" class="empty-icon" />
        <p>
          No composite tools yet. A composite chains several existing tool calls into one, exposed on the aggregated MCP
          endpoint.
        </p>
      </div>
    </template>

    <div v-else class="table-card table-scroll">
      <table class="composites-table">
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
            <td class="desc-cell" :title="c.description || undefined">{{ c.description || "—" }}</td>
            <td>{{ c.stepsCount }}</td>
            <td>
              <button
                type="button"
                class="toggle"
                :class="c.enabled ? 'toggle-on' : 'toggle-off'"
                :aria-pressed="c.enabled"
                @click="toggleEnabled(c)"
              >
                {{ c.enabled ? "Disable composite" : "Enable composite" }}
              </button>
              <p v-if="rowError[c.name]" class="row-error">{{ rowError[c.name] }}</p>
            </td>
            <td><button type="button" class="link-btn danger" @click="requestDelete(c)">Delete</button></td>
          </tr>
        </tbody>
      </table>
    </div>

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
      @cancel="pendingDelete = null"
    />
  </section>
</template>

<style scoped>
.page-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  margin-bottom: 1.25rem;
}
.page-header h1 {
  margin: 0 0 0.2rem;
}
.subtitle {
  color: var(--text-secondary);
  margin: 0;
  max-width: 560px;
}
.create-form {
  background: var(--surface);
  border: 1px solid var(--border);
  padding: 1.25rem;
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-xs);
  margin-bottom: 1.5rem;
  max-width: 560px;
  display: flex;
  flex-direction: column;
  gap: 0.8rem;
}
.field label {
  display: block;
  font-weight: 600;
  font-size: 0.85rem;
  margin-bottom: 0.3rem;
}
.field input,
.field textarea {
  width: 100%;
  padding: 0.55rem 0.7rem;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  box-sizing: border-box;
  font-size: 0.9rem;
  font-family: var(--font-body);
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
.table-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-xs);
}
.composites-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.9rem;
}
.composites-table th {
  text-align: left;
  padding: 0.65rem 0.85rem;
  border-bottom: 1px solid var(--border);
  color: var(--text-muted);
  font-size: 0.74rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.composites-table td {
  padding: 0.6rem 0.85rem;
  border-bottom: 1px solid var(--border);
  vertical-align: middle;
}
.composites-table tbody tr:last-child td {
  border-bottom: none;
}
.composites-table tbody tr:hover {
  background: var(--surface-sunken);
}
.desc-cell {
  color: var(--text-secondary);
  max-width: 320px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.toggle {
  display: inline-flex;
  align-items: center;
  gap: 0.45em;
  border-radius: var(--radius-pill);
  padding: 0.28rem 0.8rem;
  font-size: 0.78rem;
  font-weight: 600;
  cursor: pointer;
  background: var(--surface);
  transition: background-color 0.12s ease;
}
.toggle::before {
  content: "";
  width: 0.55em;
  height: 0.55em;
  border-radius: 50%;
  background: currentColor;
  flex-shrink: 0;
}
.toggle-on {
  border: 1px solid var(--ok);
  color: var(--ok);
}
.toggle-off {
  border: 1px solid var(--border-strong);
  color: var(--text-secondary);
}
.toggle-on:hover {
  background: var(--ok-soft);
}
.toggle-off:hover {
  background: var(--surface-sunken);
}
.row-error {
  color: var(--breach);
  font-size: 0.75rem;
  margin: 0.25rem 0 0;
}
.link-btn.danger {
  color: var(--breach);
}
.empty-state {
  padding: 3rem 2rem;
  text-align: center;
  color: var(--text-secondary);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
}
.empty-icon {
  color: var(--text-muted);
  margin-bottom: 0.75rem;
}
.loading {
  color: var(--text-secondary);
  padding: 1rem 0;
}
</style>
