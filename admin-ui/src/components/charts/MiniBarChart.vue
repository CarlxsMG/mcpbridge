<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";

const { t } = useI18n({ useScope: "global" });

const props = defineProps<{
  rows: { label: string; value: number; hint?: string; danger?: boolean }[];
  valueFormat?: (n: number) => string;
}>();

const max = computed(() => Math.max(...props.rows.map((r) => r.value), 1));
const format = computed(() => props.valueFormat ?? ((n: number) => String(n)));
</script>

<template>
  <div class="mini-bar-chart">
    <div v-for="r in rows" :key="r.label" class="bar-row">
      <span class="bar-label" :title="r.label">{{ r.label }}</span>
      <div class="bar-track">
        <div
          class="bar-fill"
          :class="{ danger: r.danger }"
          :style="{ width: Math.max((r.value / max) * 100, 2) + '%' }"
        />
      </div>
      <span class="bar-value"
        >{{ format(r.value) }}<span v-if="r.hint" class="bar-hint"> · {{ r.hint }}</span></span
      >
    </div>
    <p v-if="!rows.length" class="bar-empty">{{ t('components.charts.no_data_window') }}</p>
  </div>
</template>

<style scoped>
.mini-bar-chart {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.bar-row {
  display: grid;
  grid-template-columns: minmax(0, 9rem) 1fr auto;
  align-items: center;
  gap: var(--space-2);
}
.bar-label {
  font-size: var(--text-sm);
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-mono);
}
.bar-track {
  height: 0.5rem;
  border-radius: var(--radius-pill);
  background: var(--surface-sunken);
  overflow: hidden;
}
.bar-fill {
  height: 100%;
  border-radius: var(--radius-pill);
  background: var(--signal);
  transition: width 0.4s ease;
}
.bar-fill.danger {
  background: var(--breach);
}
.bar-value {
  font-size: var(--text-sm);
  font-weight: 600;
  color: var(--text-primary);
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
.bar-hint {
  font-weight: 400;
  color: var(--text-muted);
}
.bar-empty {
  color: var(--text-muted);
  font-size: var(--text-md);
  margin: 0;
}
</style>
