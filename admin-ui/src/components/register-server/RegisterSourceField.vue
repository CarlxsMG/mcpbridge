<script setup lang="ts">
/**
 * The single field the register-server flow opens with, plus the correction UI
 * for whatever `detectSource` inferred from it.
 *
 * The parent owns both the text and the resolved source (it needs them to build
 * the discovery payload), so this component takes the detection as a prop and
 * emits the user's correction rather than deciding anything itself.
 *
 * The correction affordance is not optional decoration: `detectSource`
 * deliberately returns "I cannot tell" for an extension-less URL, and any
 * heuristic can be wrong on a real-world host. A user who cannot say "no, it's
 * an MCP server" is stuck, which is a worse outcome than the old form's
 * explicit kind/mode toggles.
 */
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import {
  SOURCE_IDS,
  looksLikeSchemelessUrl,
  type SourceDetection,
  type SourceId,
  type UnsupportedInput,
} from "@/utils/registerSource";
import FormField from "@/components/ui/FormField.vue";

const props = defineProps<{
  detection: SourceDetection;
  /** The detection, or the user's override — whichever the parent is acting on. */
  activeSource: SourceId | null;
  /** Set when the user overrode the detection, so the wording can say so. */
  overridden: boolean;
  error?: string;
}>();

const source = defineModel<string>("source", { required: true });
const emit = defineEmits<{ pick: [SourceId] }>();

const { t } = useI18n({ useScope: "global" });

const fileName = ref("");
const showAllChoices = ref(false);

/**
 * The explanation for each unregisterable input. Typed as a total Record so the
 * compiler asks for a message when `UnsupportedInput` grows a member — a missing
 * branch would render a blank paragraph, which is the failure this whole outcome
 * exists to prevent.
 */
const UNSUPPORTED_KEYS: Record<UnsupportedInput, string> = {
  "inline-openapi": "pages.register_server.source_inline_openapi",
};

const unsupportedKey = computed(() =>
  props.detection.unsupported ? UNSUPPORTED_KEYS[props.detection.unsupported] : "",
);

/**
 * The source every piece of wording below speaks about. It goes silent on
 * unregisterable input even when the parent still holds a source: a "Registering
 * as: MCP server." line under a paragraph saying this text cannot be registered
 * is the contradiction, and this collapses both readings into one.
 */
const shownSource = computed<SourceId | null>(() => (props.detection.unsupported ? null : props.activeSource));

/**
 * Which alternatives to offer. Ambiguous input gets exactly the two candidates
 * (the question is narrow — asking it with six pills would bury the answer);
 * unrecognized input gets everything, since nothing has been ruled out.
 *
 * Unregisterable input gets NONE, ahead of every other rule including the user's
 * own "show me all six" — there is no pill that would make an inline spec
 * registrable, so each one is an invitation to a URL-validation error. The
 * message rendered in its place says what to paste instead.
 */
const offeredChoices = computed<readonly SourceId[]>(() => {
  if (props.detection.unsupported) return [];
  if (showAllChoices.value) return SOURCE_IDS;
  if (props.detection.ambiguous.length > 0) return props.detection.ambiguous;
  return props.activeSource === null && props.detection.hasInput ? SOURCE_IDS : [];
});

const schemeless = computed(() => looksLikeSchemelessUrl(source.value));

function choose(id: SourceId) {
  showAllChoices.value = false;
  emit("pick", id);
}

function onFileChange(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  fileName.value = file.name;
  const reader = new FileReader();
  reader.onload = () => {
    source.value = typeof reader.result === "string" ? reader.result : "";
  };
  reader.readAsText(file);
}
</script>

<template>
  <FormField v-slot="field" :label="t('pages.register_server.source_label')" for="r-source" :error="error">
    <textarea
      id="r-source"
      v-model="source"
      class="source-input"
      rows="3"
      spellcheck="false"
      :placeholder="t('pages.register_server.source_placeholder')"
      v-bind="field"
    ></textarea>
    <div class="file-row">
      <label for="r-source-file">{{ t("pages.register_server.source_file_label") }}</label>
      <input id="r-source-file" type="file" accept="application/json,.json" @change="onFileChange" />
      <span v-if="fileName" class="hint">{{ t("pages.register_server.postman_loaded", { name: fileName }) }}</span>
    </div>
  </FormField>

  <!-- Ahead of the "Detected: …" line on purpose: the input being unregisterable
       is a fact about the text, not a guess, so it also outranks a source the
       user picked earlier and left standing while pasting something new. -->
  <p v-if="unsupportedKey" class="ask dead-end">
    {{ t(unsupportedKey) }}
  </p>

  <p v-else-if="shownSource" class="detected">
    <span>{{
      overridden
        ? t("pages.register_server.source_chosen", { source: t(`pages.register_server.source_names.${shownSource}`) })
        : t("pages.register_server.source_detected", {
            source: t(`pages.register_server.source_names.${shownSource}`),
          })
    }}</span>
    <button v-if="!showAllChoices" type="button" class="link-btn" @click="showAllChoices = true">
      {{ t("pages.register_server.source_change") }}
    </button>
  </p>

  <p v-else-if="detection.ambiguous.length > 0" class="ask">
    {{ t("pages.register_server.source_ambiguous") }}
  </p>
  <p v-else-if="schemeless" class="ask">
    {{ t("pages.register_server.source_schemeless") }}
  </p>
  <p v-else-if="detection.hasInput" class="ask">
    {{ t("pages.register_server.source_unknown") }}
  </p>

  <div
    v-if="offeredChoices.length > 0"
    class="choices"
    role="group"
    :aria-label="t('pages.register_server.source_aria')"
  >
    <button
      v-for="id in offeredChoices"
      :key="id"
      type="button"
      class="choice"
      :aria-pressed="activeSource === id"
      @click="choose(id)"
    >
      {{ t(`pages.register_server.source_names.${id}`) }}
    </button>
  </div>

  <p v-if="shownSource === 'curl'" class="hint">{{ t("pages.register_server.curl_hint") }}</p>
  <p v-else-if="shownSource === 'manual'" class="hint">{{ t("pages.register_server.manual_hint") }}</p>
  <p v-else-if="shownSource === 'mcp'" class="hint">{{ t("pages.register_server.mcp_transport_hint") }}</p>
</template>

<style scoped>
.source-input {
  font-family: var(--font-mono);
  font-size: 0.82rem;
}
.file-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-wrap: wrap;
  margin-top: var(--space-2);
}
.file-row label {
  font-size: 0.8rem;
  font-weight: 400;
  color: var(--text-secondary);
  margin: 0;
}
.file-row input[type="file"] {
  font-size: 0.8rem;
  padding: 0;
  border: none;
  width: auto;
}
.detected,
.ask {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-wrap: wrap;
  font-size: 0.85rem;
  margin: 0;
}
.detected {
  color: var(--text-secondary);
}
.ask {
  color: var(--canary-text);
  font-weight: 600;
}
/* A full sentence rather than a one-line prompt, so it wraps as a paragraph
   instead of inheriting `.ask`'s single-row, vertically-centred flex layout. */
.ask.dead-end {
  display: block;
  line-height: 1.45;
}
.choices {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}
.choice {
  border-radius: var(--radius-pill);
  border: 1px solid var(--border-strong);
  background: var(--surface);
  color: var(--text-secondary);
  padding: 0.28rem 0.8rem;
  font-size: 0.78rem;
  font-weight: 600;
  cursor: pointer;
}
.choice:hover {
  background: var(--surface-sunken);
  color: var(--text-primary);
}
.choice[aria-pressed="true"] {
  border-color: var(--signal);
  color: var(--signal-strong);
  background: var(--signal-soft);
}
.hint {
  font-size: 0.82rem;
  color: var(--text-secondary);
  margin: 0;
}
</style>
