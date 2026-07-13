<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import ModalShell from "@/components/ui/ModalShell.vue";
import SearchInput from "@/components/ui/SearchInput.vue";
import { X } from "lucide-vue-next";
import { CATALOG_PRESETS, GROUP_LABELS, GROUP_ORDER, type WidgetPreset } from "./widgetCatalog";

defineProps<{ open: boolean }>();
const emit = defineEmits<{ close: []; add: [preset: WidgetPreset] }>();
const { t } = useI18n({ useScope: "global" });

const query = ref("");

// `label`/`description` on CATALOG_PRESETS are i18n key paths (GROUP_LABELS
// pattern), not display text — resolve them here so search + rendering both
// use the current-locale string, and re-resolve reactively on locale switch.
const resolvedPresets = computed(() =>
  CATALOG_PRESETS.map((p) => ({ ...p, resolvedLabel: t(p.label), resolvedDescription: t(p.description) })),
);

const grouped = computed(() => {
  const q = query.value.trim().toLowerCase();
  const match = (p: (typeof resolvedPresets.value)[number]) =>
    !q || p.resolvedLabel.toLowerCase().includes(q) || p.resolvedDescription.toLowerCase().includes(q);
  return GROUP_ORDER.map((group) => ({
    group,
    label: t(GROUP_LABELS[group]),
    presets: resolvedPresets.value.filter((p) => p.group === group && match(p)),
  })).filter((g) => g.presets.length > 0);
});

function onAdd(preset: WidgetPreset) {
  emit("add", preset);
}
</script>

<template>
  <!-- :ariaLabel kept camelCase (not :aria-label): vue-tsc treats the hyphenated form as the
       built-in ARIA passthrough attribute rather than resolving it to ModalShell's ariaLabel prop -->
  <!-- eslint-disable-next-line vue/attribute-hyphenation -->
  <ModalShell :open="open" :ariaLabel="t('components.add_widget.title')" max-width="46rem" @close="emit('close')">
    <div class="add-head">
      <h2>{{ t("components.add_widget.title") }}</h2>
      <button type="button" class="icon-btn" :aria-label="t('common.close')" @click="emit('close')">
        <X :size="18" stroke-width="2" aria-hidden="true" />
      </button>
    </div>
    <p class="add-sub">{{ t("components.add_widget.hint") }}</p>

    <div class="add-search">
      <SearchInput v-model="query" :placeholder="t('components.add_widget.search_placeholder')" />
    </div>

    <div class="add-scroll">
      <section v-for="g in grouped" :key="g.group" class="add-group">
        <h3 class="add-group-title">{{ g.label }}</h3>
        <div class="add-grid">
          <button v-for="p in g.presets" :key="p.key" type="button" class="preset" @click="onAdd(p)">
            <span class="preset-icon"><component :is="p.icon" :size="16" stroke-width="2" aria-hidden="true" /></span>
            <span class="preset-text">
              <span class="preset-label">{{ p.resolvedLabel }}</span>
              <span class="preset-desc">{{ p.resolvedDescription }}</span>
            </span>
          </button>
        </div>
      </section>
      <p v-if="grouped.length === 0" class="add-empty">{{ t("components.add_widget.no_match", { query }) }}</p>
    </div>
  </ModalShell>
</template>

<style scoped>
.add-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
}
.add-head h2 {
  margin: 0;
  font-size: var(--text-lg);
}
.icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 2rem;
  height: 2rem;
  border: none;
  background: none;
  border-radius: var(--radius-sm);
  color: var(--text-muted);
  cursor: pointer;
}
.icon-btn:hover {
  background: var(--surface-sunken);
  color: var(--text-primary);
}
.add-sub {
  margin: var(--space-2) 0 var(--space-4);
  color: var(--text-secondary);
  font-size: var(--text-sm);
}
.add-search {
  margin-bottom: var(--space-4);
}
.add-scroll {
  max-height: 55vh;
  overflow-y: auto;
}
.add-group + .add-group {
  margin-top: var(--space-5);
}
.add-group-title {
  margin: 0 0 var(--space-2);
  font-size: var(--text-xs);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-muted);
  font-weight: 600;
}
.add-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(15rem, 1fr));
  gap: var(--space-2);
}
.preset {
  display: flex;
  align-items: flex-start;
  gap: var(--space-3);
  text-align: left;
  padding: var(--space-3);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--surface);
  cursor: pointer;
  transition:
    border-color 0.12s ease,
    background-color 0.12s ease;
}
.preset:hover {
  border-color: var(--signal);
  background: var(--signal-soft);
}
.preset-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 1.75rem;
  height: 1.75rem;
  flex-shrink: 0;
  border-radius: var(--radius-sm);
  background: var(--signal-soft);
  color: var(--signal-strong);
}
.preset-text {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.preset-label {
  font-weight: 600;
  font-size: var(--text-base);
  color: var(--text-primary);
}
.preset-desc {
  font-size: var(--text-xs);
  color: var(--text-muted);
}
.add-empty {
  color: var(--text-muted);
  font-size: var(--text-sm);
}
</style>
