<script setup lang="ts">
import { reactive, watch } from "vue";
import { useI18n } from "vue-i18n";
import ModalShell from "@/components/ui/ModalShell.vue";
import SelectMenu from "@/components/ui/SelectMenu.vue";
import { Minus, Plus } from "lucide-vue-next";
import {
  STAT_METRICS,
  TIMESERIES_SERIES,
  DONUT_BREAKDOWNS,
  BARS_RANKINGS,
  LIST_FEEDS,
  STAT_BY_ID,
  GROUP_LABELS,
  GRID_COLUMNS,
  MAX_H,
  type WidgetInstance,
  type WidgetOptions,
  type WidgetTone,
} from "./widgetCatalog";

const props = defineProps<{ open: boolean; widget: WidgetInstance | null }>();
const emit = defineEmits<{
  close: [];
  save: [payload: { id: string; options: WidgetOptions; w: number; h: number }];
}>();
const { t } = useI18n({ useScope: "global" });

const draft = reactive({
  title: "",
  metric: "",
  series: "",
  breakdown: "",
  ranking: "",
  feed: "",
  unit: "",
  tone: "default" as WidgetTone,
  warn: "",
  danger: "",
  text: "",
  w: 3,
  h: 1,
});

function seed(w: WidgetInstance): void {
  draft.title = w.options.title ?? "";
  draft.metric = w.options.metric ?? STAT_METRICS[0].id;
  draft.series = w.options.series ?? TIMESERIES_SERIES[0].id;
  draft.breakdown = w.options.breakdown ?? DONUT_BREAKDOWNS[0].id;
  draft.ranking = w.options.ranking ?? BARS_RANKINGS[0].id;
  draft.feed = w.options.feed ?? LIST_FEEDS[0].id;
  draft.unit = w.options.unit ?? "";
  draft.tone = w.options.tone ?? "default";
  draft.warn = w.options.thresholds?.warn != null ? String(w.options.thresholds.warn) : "";
  draft.danger = w.options.thresholds?.danger != null ? String(w.options.thresholds.danger) : "";
  draft.text = w.options.text ?? "";
  draft.w = w.w;
  draft.h = w.h;
}

// Re-seed when the dialog opens (id goes null -> id) or switches widget while open.
watch(
  () => (props.open ? props.widget?.id : null),
  () => {
    if (props.open && props.widget) seed(props.widget);
  },
);

const toGroupedOptions = <T extends { id: string; label: string; group: keyof typeof GROUP_LABELS }>(defs: T[]) =>
  defs.map((d) => ({ value: d.id, label: `${t(GROUP_LABELS[d.group])} · ${d.label}` }));

const metricOptions = toGroupedOptions(STAT_METRICS);
const seriesOptions = toGroupedOptions(TIMESERIES_SERIES);
const breakdownOptions = toGroupedOptions(DONUT_BREAKDOWNS);
const rankingOptions = toGroupedOptions(BARS_RANKINGS);
const feedOptions = toGroupedOptions(LIST_FEEDS);
const toneOptions: { value: WidgetTone; label: string }[] = [
  { value: "auto", label: t("components.widget_config.tone.auto") },
  { value: "default", label: t("components.widget_config.tone.default") },
  { value: "ok", label: t("components.widget_config.tone.ok") },
  { value: "warning", label: t("components.widget_config.tone.warning") },
  { value: "danger", label: t("components.widget_config.tone.danger") },
];

function numOrUndef(s: string): number | undefined {
  const n = Number(s);
  return s.trim() !== "" && Number.isFinite(n) ? n : undefined;
}

function stepW(delta: number): void {
  draft.w = Math.min(Math.max(draft.w + delta, 1), GRID_COLUMNS);
}
function stepH(delta: number): void {
  draft.h = Math.min(Math.max(draft.h + delta, 1), MAX_H);
}

function save(): void {
  if (!props.widget) return;
  const type = props.widget.type;
  const options: WidgetOptions = { title: draft.title.trim() || t("components.widget_config.widget_default_title") };
  if (type === "stat") {
    options.metric = draft.metric;
    options.icon = STAT_BY_ID.get(draft.metric)?.icon;
    options.unit = draft.unit.trim() || undefined;
    options.tone = draft.tone;
    if (draft.tone === "auto") {
      const warn = numOrUndef(draft.warn);
      const danger = numOrUndef(draft.danger);
      options.thresholds = warn != null || danger != null ? { warn, danger } : undefined;
    }
  } else if (type === "timeseries") options.series = draft.series;
  else if (type === "donut") options.breakdown = draft.breakdown;
  else if (type === "bars") options.ranking = draft.ranking;
  else if (type === "list") options.feed = draft.feed;
  else if (type === "note") options.text = draft.text;
  emit("save", { id: props.widget.id, options, w: draft.w, h: draft.h });
}
</script>

<template>
  <!-- :ariaLabel kept camelCase (not :aria-label): vue-tsc treats the hyphenated form as the
       built-in ARIA passthrough attribute rather than resolving it to ModalShell's ariaLabel prop -->
  <!-- eslint-disable vue/attribute-hyphenation -->
  <ModalShell
    v-if="widget"
    :open="open"
    :ariaLabel="t('components.widget_config.title')"
    max-width="32rem"
    @close="emit('close')"
  >
    <!-- eslint-enable vue/attribute-hyphenation -->
    <h2 class="cfg-title">{{ t("components.widget_config.title") }}</h2>

    <form @submit.prevent="save">
      <div class="field">
        <label for="cfg-title">{{ t("components.widget_config.fields.title") }}</label>
        <input id="cfg-title" v-model="draft.title" type="text" maxlength="60" />
      </div>

      <template v-if="widget.type === 'stat'">
        <div class="field">
          <label for="cfg-metric">{{ t("components.widget_config.fields.metric") }}</label>
          <SelectMenu id="cfg-metric" v-model="draft.metric" :options="metricOptions" />
        </div>
        <div class="field-row">
          <div class="field">
            <label for="cfg-unit">{{ t("components.widget_config.fields.unit") }}</label>
            <input
              id="cfg-unit"
              v-model="draft.unit"
              type="text"
              maxlength="8"
              :placeholder="t('components.widget_config.placeholders.unit')"
            />
          </div>
          <div class="field">
            <label for="cfg-tone">{{ t("components.widget_config.fields.color") }}</label>
            <SelectMenu id="cfg-tone" v-model="draft.tone" :options="toneOptions" />
          </div>
        </div>
        <div v-if="draft.tone === 'auto'" class="field-row">
          <div class="field">
            <label for="cfg-warn">{{ t("components.widget_config.fields.warn_at") }}</label>
            <input
              id="cfg-warn"
              v-model="draft.warn"
              type="number"
              step="any"
              :placeholder="t('components.widget_config.placeholders.none')"
            />
          </div>
          <div class="field">
            <label for="cfg-danger">{{ t("components.widget_config.fields.danger_at") }}</label>
            <input
              id="cfg-danger"
              v-model="draft.danger"
              type="number"
              step="any"
              :placeholder="t('components.widget_config.placeholders.none')"
            />
          </div>
        </div>
      </template>

      <div v-else-if="widget.type === 'timeseries'" class="field">
        <label for="cfg-series">{{ t("components.widget_config.fields.series") }}</label>
        <SelectMenu id="cfg-series" v-model="draft.series" :options="seriesOptions" />
      </div>

      <div v-else-if="widget.type === 'donut'" class="field">
        <label for="cfg-breakdown">{{ t("components.widget_config.fields.breakdown") }}</label>
        <SelectMenu id="cfg-breakdown" v-model="draft.breakdown" :options="breakdownOptions" />
      </div>

      <div v-else-if="widget.type === 'bars'" class="field">
        <label for="cfg-ranking">{{ t("components.widget_config.fields.ranking") }}</label>
        <SelectMenu id="cfg-ranking" v-model="draft.ranking" :options="rankingOptions" />
      </div>

      <div v-else-if="widget.type === 'list'" class="field">
        <label for="cfg-feed">{{ t("components.widget_config.fields.feed") }}</label>
        <SelectMenu id="cfg-feed" v-model="draft.feed" :options="feedOptions" />
      </div>

      <div v-else-if="widget.type === 'note'" class="field">
        <label for="cfg-text">{{ t("components.widget_config.fields.text") }}</label>
        <textarea
          id="cfg-text"
          v-model="draft.text"
          rows="6"
          :placeholder="t('components.widget_config.placeholders.markdown')"
        />
      </div>

      <div class="size-fields">
        <span class="size-label">{{ t("components.widget_config.size.label") }}</span>
        <div class="stepper" role="group" :aria-label="t('components.widget_config.size.width_aria')">
          <span class="stepper-name">{{ t("components.widget_config.size.width") }}</span>
          <button
            type="button"
            :aria-label="t('components.widget_config.size.narrower')"
            :disabled="draft.w <= 1"
            @click="stepW(-1)"
          >
            <Minus :size="13" stroke-width="2" aria-hidden="true" />
          </button>
          <span class="stepper-value">{{ draft.w }}/{{ GRID_COLUMNS }}</span>
          <button
            type="button"
            :aria-label="t('components.widget_config.size.wider')"
            :disabled="draft.w >= GRID_COLUMNS"
            @click="stepW(1)"
          >
            <Plus :size="13" stroke-width="2" aria-hidden="true" />
          </button>
        </div>
        <div class="stepper" role="group" :aria-label="t('components.widget_config.size.height_aria')">
          <span class="stepper-name">{{ t("components.widget_config.size.height") }}</span>
          <button
            type="button"
            :aria-label="t('components.widget_config.size.shorter')"
            :disabled="draft.h <= 1"
            @click="stepH(-1)"
          >
            <Minus :size="13" stroke-width="2" aria-hidden="true" />
          </button>
          <span class="stepper-value">{{ draft.h }}/{{ MAX_H }}</span>
          <button
            type="button"
            :aria-label="t('components.widget_config.size.taller')"
            :disabled="draft.h >= MAX_H"
            @click="stepH(1)"
          >
            <Plus :size="13" stroke-width="2" aria-hidden="true" />
          </button>
        </div>
      </div>

      <div class="cfg-actions">
        <button type="button" class="btn-secondary" @click="emit('close')">{{ t("common.cancel") }}</button>
        <button type="submit" class="btn-primary">{{ t("common.save") }}</button>
      </div>
    </form>
  </ModalShell>
</template>

<style scoped>
.cfg-title {
  margin: 0 0 var(--space-4);
  font-size: var(--text-lg);
}
.field {
  margin-bottom: var(--space-4);
}
.field label {
  display: block;
  font-size: 0.85rem;
  font-weight: 600;
  margin-bottom: 0.3rem;
}
.field input,
.field textarea {
  width: 100%;
  padding: 0.55rem 0.7rem;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  font-size: 0.9rem;
  font-family: var(--font-body);
  box-sizing: border-box;
}
.field textarea {
  resize: vertical;
  font-family: var(--font-mono);
}
.field :deep(.select-menu) {
  display: block;
  width: 100%;
}
.field-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--space-3);
}
.size-fields {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-3);
  margin: var(--space-2) 0 var(--space-5);
}
.size-label {
  font-size: 0.85rem;
  font-weight: 600;
}
.stepper {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: var(--space-1) var(--space-2);
}
.stepper-name {
  font-size: var(--text-sm);
  color: var(--text-secondary);
}
.stepper-value {
  font-size: var(--text-sm);
  font-variant-numeric: tabular-nums;
  min-width: 2.5rem;
  text-align: center;
}
.stepper button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 1.375rem;
  height: 1.375rem;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  background: var(--surface);
  color: var(--text-secondary);
  cursor: pointer;
}
.stepper button:hover:not(:disabled) {
  border-color: var(--signal);
  color: var(--signal-strong);
}
.stepper button:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.cfg-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
}
</style>
