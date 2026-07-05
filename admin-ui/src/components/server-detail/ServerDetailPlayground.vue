<script setup lang="ts">
import { ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { api } from "@/composables/useApi";
import { toolPath } from "@/utils/apiPaths";
import { toErrorMessage } from "@/utils/errors";
import { tk } from "@/i18n";
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
const { t } = useI18n({ useScope: "global" });

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
    const res = await api.get<{ items: ToolExample[] }>(toolPath(props.clientName, toolName, "examples"));
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
      toolPath(props.clientName, props.tool.name, "test"),
      playgroundArgs.value,
    );
    playgroundResult.value = { text: result.content.map((c) => c.text).join("\n"), isError: Boolean(result.isError) };
  } catch (err) {
    playgroundResult.value = { text: toErrorMessage(err, tk("components.server_detail_playground.errors.test_failed")), isError: true };
  } finally {
    playgroundRunning.value = false;
  }
}

async function saveExample() {
  if (!newExampleLabel.value.trim()) return;
  savingExample.value = true;
  try {
    await api.post(toolPath(props.clientName, props.tool.name, "examples"), {
      label: newExampleLabel.value.trim(),
      args: playgroundArgs.value,
    });
    newExampleLabel.value = "";
    await loadExamples(props.tool.name);
  } catch (err) {
    playgroundResult.value = { text: toErrorMessage(err, tk("components.server_detail_playground.errors.save_failed")), isError: true };
  } finally {
    savingExample.value = false;
  }
}

async function deleteExampleFn(ex: ToolExample) {
  try {
    await api.delete(toolPath(props.clientName, props.tool.name, "examples", String(ex.id)));
    await loadExamples(props.tool.name);
  } catch {
    /* ignore */
  }
}
</script>

<template>
  <section class="playground">
    <h3>{{ t('components.server_detail_playground.title') }}</h3>
    <p class="hint">{{ t('components.server_detail_playground.hint') }}</p>

    <div v-if="examples.length" class="examples">
      <span class="ex-label">{{ t('components.server_detail_playground.saved_examples') }}:</span>
      <span v-for="ex in examples" :key="ex.id" class="ex-chip">
        <button type="button" class="link-btn" @click="loadExampleIntoForm(ex)">{{ ex.label }}</button>
        <button
          type="button"
          class="link-btn del"
          :title="t('components.server_detail_playground.delete_example')"
          :aria-label="t('components.server_detail_playground.delete_example_aria', { label: ex.label })"
          @click="deleteExampleFn(ex)"
        >
          ×
        </button>
      </span>
    </div>

    <SchemaForm v-model="playgroundArgs" :schema="tool.inputSchema" />

    <div class="pg-actions">
      <button type="button" class="btn-primary" :disabled="playgroundRunning" @click="runPlayground">
        {{ playgroundRunning ? t('components.server_detail_playground.running') : t('components.server_detail_playground.run') }}
      </button>
      <span class="save-ex">
        <input v-model="newExampleLabel" type="text" :placeholder="t('components.server_detail_playground.save_placeholder')" />
        <button
          type="button"
          class="btn-secondary"
          :disabled="savingExample || !newExampleLabel.trim()"
          @click="saveExample"
        >
          {{ t('common.save') }}
        </button>
      </span>
    </div>

    <div v-if="playgroundResult" class="test-result" :class="playgroundResult.isError ? 'test-error' : 'test-ok'">
      <pre>{{ playgroundResult.text }}</pre>
    </div>
  </section>
</template>