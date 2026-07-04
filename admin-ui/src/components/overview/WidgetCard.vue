<script setup lang="ts">
// Uniform panel shell for the non-stat viz renderers (donut/bars/timeseries/
// list/note): a surface card with a small heading, matching ChartCard's look
// but full-height so panels in the same grid row align. Stat widgets use
// StatCard directly (it is itself a carded "big number" tile).
// `center` vertically centers the body content (used by the donut, whose ring
// looks best centered); feeds/bars/timeseries top-align.
defineProps<{ title: string; center?: boolean }>();
</script>

<template>
  <div class="widget-card">
    <h3 class="widget-card-title">{{ title }}</h3>
    <div class="widget-card-body" :class="{ center }"><slot /></div>
  </div>
</template>

<style scoped>
.widget-card {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-xs);
  padding: var(--space-4) var(--space-5);
}
.widget-card-title {
  flex-shrink: 0;
  font-size: var(--text-sm);
  margin: 0 0 var(--space-3);
  color: var(--text-secondary);
  font-family: var(--font-body);
  font-weight: 600;
}
.widget-card-body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  justify-content: flex-start;
  overflow: auto;
}
.widget-card-body.center {
  justify-content: center;
}
</style>
