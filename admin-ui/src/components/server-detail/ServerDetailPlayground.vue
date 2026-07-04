<script setup lang="ts">
import { ref, watch } from "vue";
import { api, ApiError } from "@/composables/useApi";
import SchemaForm from "@/components/SchemaForm.vue";
import type { ToolDetail } from "@/types/api";

interface ToolExample {
  id: number;
  label: string;
  args: Record<string, unknown>;
  createdAt: number;
  createdBy: string | null;
}

const props = defineProps<{ clientName: string; tool: ToolDetail }>();

const playgroundArgs = ref<Record<string, unknown>>({});
const examples = ref<ToolExample[]>([]);
const newExampleLabel = ref("");
const savingExample = ref(false);
const playgroundResult = ref<{ text: string; isError: boolean } | null>(null);
const playgroundRunning = ref(false);

watch(
  () => props.tool.name,
  (name) => {
    playgroundArgs.value = {};
    playgroundResult.value = null;
    examples.value = [];
    newExampleLabel.value = "";
    if (name) void loadExamples(name);
  },
  { immediate: true },
);

async function loadExamples(toolName: string) {
  try {
    const res = await api.get<{ items: ToolExample[] }>(
      `/admin-api/clients/${encodeURIComponent(props.clientName)}/tools/${encodeURIComponent(toolName)}/examples`,
    );
    examples.value = res.items;
  } catch {
    examples.value = [];
  }
}

function loadExampleIntoForm(ex: ToolExample) {
  playgroundArgs.value = { ...ex.args };
}

async function runPlayground() {
  playgroundRunning.value = true;
  playgroundResult.value = null;
  try {
    const result = await api.post<{ content: { type: string; text: string }[]; isError?: boolean }>(
      `/admin-api/clients/${encodeURIComponent(props.clientName)}/tools/${encodeURIComponent(props.tool.name)}/test`,
      playgroundArgs.value,
    );
    playgroundResult.value = { text: result.content.map((c) => c.text).join("\n"), isError: Boolean(result.isError) };
  } catch (err) {
    playgroundResult.value = { text: err instanceof ApiError ? err.message : "Test call failed.", isError: true };
  } finally {
    playgroundRunning.value = false;
  }
}

async function saveExample() {
  if (!newExampleLabel.value.trim()) return;
  savingExample.value = true;
  try {
    await api.post(
      `/admin-api/clients/${encodeURIComponent(props.clientName)}/tools/${encodeURIComponent(props.tool.name)}/examples`,
      { label: newExampleLabel.value.trim(), args: playgroundArgs.value },
    );
    newExampleLabel.value = "";
    await loadExamples(props.tool.name);
  } catch (err) {
    playgroundResult.value = { text: err instanceof ApiError ? err.message : "Failed to save example.", isError: true };
  } finally {
    savingExample.value = false;
  }
}

async function deleteExampleFn(ex: ToolExample) {
  try {
    await api.delete(
      `/admin-api/clients/${encodeURIComponent(props.clientName)}/tools/${encodeURIComponent(props.tool.name)}/examples/${ex.id}`,
    );
    await loadExamples(props.tool.name);
  } catch {
    /* ignore */
  }
}
</script>

<template>
  <section class="playground">
    <h3>Playground</h3>
    <p class="hint">Fill arguments from the tool's schema and run a real test call through the full guard stack.</p>

    <div v-if="examples.length" class="examples">
      <span class="ex-label">Saved examples:</span>
      <span v-for="ex in examples" :key="ex.id" class="ex-chip">
        <button type="button" class="link-btn" @click="loadExampleIntoForm(ex)">{{ ex.label }}</button>
        <button
          type="button"
          class="link-btn del"
          title="Delete example"
          :aria-label="`Delete ${ex.label}`"
          @click="deleteExampleFn(ex)"
        >
          ×
        </button>
      </span>
    </div>

    <SchemaForm v-model="playgroundArgs" :schema="tool.inputSchema" />

    <div class="pg-actions">
      <button type="button" class="btn-primary" :disabled="playgroundRunning" @click="runPlayground">
        {{ playgroundRunning ? "Running…" : "Run test" }}
      </button>
      <span class="save-ex">
        <input v-model="newExampleLabel" type="text" placeholder="Save as… (label)" />
        <button
          type="button"
          class="btn-secondary"
          :disabled="savingExample || !newExampleLabel.trim()"
          @click="saveExample"
        >
          Save
        </button>
      </span>
    </div>

    <div v-if="playgroundResult" class="test-result" :class="playgroundResult.isError ? 'test-error' : 'test-ok'">
      <pre>{{ playgroundResult.text }}</pre>
    </div>
  </section>
</template>
