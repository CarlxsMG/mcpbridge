<script setup lang="ts">
import { ref, onMounted } from "vue";
import { api, ApiError } from "../composables/useApi";
import type { CompositeSummary, CompositeDetail, CompositeStep } from "../types/api";

const items = ref<CompositeSummary[]>([]);
const loading = ref(false);
const errorMessage = ref("");
const rowError = ref<Record<string, string>>({});

const showCreateForm = ref(false);
const newName = ref("");
const newDescription = ref("");
const newSchema = ref('{\n  "type": "object",\n  "properties": {}\n}');
const newSteps = ref('[\n  { "targetClient": "", "targetTool": "", "argsTemplate": {} }\n]');
const createError = ref("");
const creating = ref(false);

async function load() {
  loading.value = true;
  errorMessage.value = "";
  try {
    const res = await api.get<{ items: CompositeSummary[] }>("/admin-api/composites");
    items.value = res.items;
  } catch (err) {
    errorMessage.value = err instanceof ApiError ? err.message : "Failed to load composites.";
  } finally {
    loading.value = false;
  }
}
onMounted(load);

async function createComposite() {
  createError.value = "";
  if (!newName.value.trim()) {
    createError.value = "Name is required.";
    return;
  }
  let inputSchema: Record<string, unknown>;
  let steps: CompositeStep[];
  try {
    inputSchema = JSON.parse(newSchema.value) as Record<string, unknown>;
  } catch {
    createError.value = "inputSchema is not valid JSON.";
    return;
  }
  try {
    steps = JSON.parse(newSteps.value) as CompositeStep[];
  } catch {
    createError.value = "steps is not valid JSON.";
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

async function remove(c: CompositeSummary) {
  if (!confirm(`Delete composite "${c.name}"?`)) return;
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
  <section class="page">
    <header class="page-head">
      <h1>Composite tools</h1>
      <button class="btn-primary" @click="showCreateForm = !showCreateForm">
        {{ showCreateForm ? "Cancel" : "New composite" }}
      </button>
    </header>

    <p class="lead">
      A composite chains several existing tool calls into one, exposed on the aggregated MCP endpoint.
      Each step forwards to a real <code>client__tool</code> through the full guard stack.
      Templates: <code>{{ '{ "$ref": "steps.0.json.id" }' }}</code> or <code>{{ '"${input.name}"' }}</code>.
    </p>

    <form v-if="showCreateForm" class="create-form" @submit.prevent="createComposite">
      <div class="field">
        <label>Name</label>
        <input v-model="newName" type="text" placeholder="lowercase, no '__'" />
      </div>
      <div class="field">
        <label>Description</label>
        <input v-model="newDescription" type="text" placeholder="Optional" />
      </div>
      <div class="field">
        <label>Input schema (JSON)</label>
        <textarea v-model="newSchema" rows="4" spellcheck="false"></textarea>
      </div>
      <div class="field">
        <label>Steps (JSON array)</label>
        <textarea v-model="newSteps" rows="6" spellcheck="false"></textarea>
      </div>
      <p v-if="createError" class="field-error">{{ createError }}</p>
      <button class="btn-primary" type="submit" :disabled="creating">{{ creating ? "Creating…" : "Create" }}</button>
    </form>

    <p v-if="errorMessage" class="field-error">{{ errorMessage }}</p>
    <p v-if="loading">Loading…</p>

    <table v-else class="grid">
      <thead>
        <tr><th>Name</th><th>Description</th><th>Steps</th><th>Enabled</th><th></th></tr>
      </thead>
      <tbody>
        <tr v-for="c in items" :key="c.name">
          <td><code>{{ c.name }}</code></td>
          <td>{{ c.description }}</td>
          <td>{{ c.stepsCount }}</td>
          <td>
            <label class="switch">
              <input type="checkbox" :checked="c.enabled" @change="toggleEnabled(c)" />
              <span>{{ c.enabled ? "on" : "off" }}</span>
            </label>
            <p v-if="rowError[c.name]" class="field-error">{{ rowError[c.name] }}</p>
          </td>
          <td><button class="link-btn" @click="remove(c)">delete</button></td>
        </tr>
        <tr v-if="items.length === 0">
          <td colspan="5" class="empty">No composite tools yet.</td>
        </tr>
      </tbody>
    </table>
  </section>
</template>

<style scoped>
.page { max-width: 900px; }
.page-head { display: flex; justify-content: space-between; align-items: center; }
.lead { color: #555; font-size: 0.9rem; }
.create-form { display: flex; flex-direction: column; gap: 0.8rem; background: #f7f8fa; padding: 1rem; border-radius: 8px; margin-bottom: 1rem; }
.field label { display: block; font-weight: 600; font-size: 0.85rem; margin-bottom: 0.3rem; }
.field input, .field textarea { width: 100%; padding: 0.45rem 0.6rem; border: 1px solid #cfd4da; border-radius: 6px; box-sizing: border-box; font-size: 0.9rem; }
.field textarea { font-family: ui-monospace, monospace; }
.grid { width: 100%; border-collapse: collapse; }
.grid th, .grid td { text-align: left; padding: 0.5rem 0.6rem; border-bottom: 1px solid #eee; font-size: 0.9rem; vertical-align: top; }
.switch { display: inline-flex; gap: 0.4rem; align-items: center; }
.empty { color: #888; text-align: center; }
.field-error { color: #a11212; font-size: 0.8rem; margin: 0.25rem 0 0; }
.link-btn { background: none; border: none; color: #a11212; cursor: pointer; }
</style>
