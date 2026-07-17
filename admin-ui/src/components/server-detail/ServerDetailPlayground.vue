<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { api } from "@/composables/useApi";
import { useConfirmAction } from "@/composables/useConfirmAction";
import { toolPath } from "@/utils/apiPaths";
import { toErrorMessage } from "@/utils/errors";
import { tk } from "@/i18n";
import SchemaForm from "@/components/SchemaForm.vue";
import ConfirmDialog from "@/components/ui/ConfirmDialog.vue";
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

// The outcome word ("Succeeded"/"Failed") announced by the persistent live
// region in the template — empty until a run produces a result. Kept separate
// from the result blob so the screen reader hears a terse pass/fail, not the
// whole payload read back.
const resultOutcome = computed(() =>
  playgroundResult.value === null
    ? ""
    : playgroundResult.value.isError
      ? t("components.server_detail_playground.result_failed")
      : t("components.server_detail_playground.result_succeeded"),
);

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
    playgroundResult.value = {
      text: toErrorMessage(err, tk("components.server_detail_playground.errors.test_failed")),
      isError: true,
    };
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
    playgroundResult.value = {
      text: toErrorMessage(err, tk("components.server_detail_playground.errors.save_failed")),
      isError: true,
    };
  } finally {
    savingExample.value = false;
  }
}

async function deleteExampleFn(ex: ToolExample) {
  try {
    await api.delete(toolPath(props.clientName, props.tool.name, "examples", String(ex.id)));
    await loadExamples(props.tool.name);
  } catch (err) {
    // Surface the failure like every other delete in the app (and like this
    // component's own save path) instead of swallowing it — otherwise the stale
    // example chip lingers with no feedback.
    playgroundResult.value = {
      text: toErrorMessage(err, tk("components.server_detail_playground.errors.delete_example_failed")),
      isError: true,
    };
  }
}

// Gate example deletion behind a confirmation, like every other destructive
// action in the app — a saved example represents real work and the × chip is a
// small, easily-misclicked target.
const {
  pending: pendingExampleDelete,
  request: requestExampleDelete,
  cancel: cancelExampleDelete,
  confirm: confirmExampleDeleteAction,
} = useConfirmAction<ToolExample>();

function confirmExampleDelete() {
  return confirmExampleDeleteAction((ex) => deleteExampleFn(ex));
}
</script>

<template>
  <section class="playground">
    <h3>{{ t("components.server_detail_playground.title") }}</h3>
    <p class="hint">{{ t("components.server_detail_playground.hint") }}</p>

    <div v-if="examples.length" class="examples">
      <span class="ex-label">{{ t("components.server_detail_playground.saved_examples") }}:</span>
      <span v-for="ex in examples" :key="ex.id" class="ex-chip">
        <button type="button" class="link-btn" @click="loadExampleIntoForm(ex)">{{ ex.label }}</button>
        <button
          type="button"
          class="link-btn del"
          :title="t('components.server_detail_playground.delete_example')"
          :aria-label="t('components.server_detail_playground.delete_example_aria', { label: ex.label })"
          @click="requestExampleDelete(ex)"
        >
          ×
        </button>
      </span>
    </div>

    <SchemaForm v-model="playgroundArgs" :schema="tool.inputSchema" />

    <div class="pg-actions">
      <button type="button" class="btn-primary" :disabled="playgroundRunning" @click="runPlayground">
        {{
          playgroundRunning
            ? t("components.server_detail_playground.running")
            : t("components.server_detail_playground.run")
        }}
      </button>
      <span class="save-ex">
        <input
          v-model="newExampleLabel"
          type="text"
          :aria-label="t('components.server_detail_playground.save_aria')"
          :placeholder="t('components.server_detail_playground.save_placeholder')"
        />
        <button
          type="button"
          class="btn-secondary"
          :disabled="savingExample || !newExampleLabel.trim()"
          @click="saveExample"
        >
          {{ t("common.save") }}
        </button>
      </span>
    </div>

    <!-- Persistent (always-mounted) live region carrying ONLY the outcome word.
         A screen reader reliably announces text that changes inside a region
         that was already in the DOM — a v-if'd region can miss its own
         insertion — so this stays rendered and only its text swaps. role and
         aria-live escalate to an assertive alert on failure; a success is a
         polite status. The colour-coded blob below is left out of the region so
         the announcement stays a terse "Succeeded"/"Failed". -->
    <div
      class="sr-only"
      :role="playgroundResult && playgroundResult.isError ? 'alert' : 'status'"
      :aria-live="playgroundResult && playgroundResult.isError ? 'assertive' : 'polite'"
    >
      {{ resultOutcome }}
    </div>

    <div v-if="playgroundResult" class="test-result" :class="playgroundResult.isError ? 'test-error' : 'test-ok'">
      <pre>{{ playgroundResult.text }}</pre>
    </div>

    <ConfirmDialog
      :open="pendingExampleDelete !== null"
      :title="t('components.server_detail_playground.confirm.delete_example_title')"
      :message="
        pendingExampleDelete
          ? t('components.server_detail_playground.confirm.delete_example_message', {
              label: pendingExampleDelete.label,
            })
          : ''
      "
      :confirm-label="t('components.server_detail_playground.confirm.delete_example_cta')"
      danger
      @confirm="confirmExampleDelete"
      @cancel="cancelExampleDelete"
    />
  </section>
</template>

<style scoped>
/* The result-outcome live region uses the global `.sr-only` utility (style.css). */
</style>
