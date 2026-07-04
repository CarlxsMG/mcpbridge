<script setup lang="ts">
withDefaults(defineProps<{ label?: string }>(), { label: "Loading…" });
</script>

<template>
  <div class="signal-loader" role="status">
    <svg class="signal-loader-svg" viewBox="0 0 120 24" preserveAspectRatio="none" aria-hidden="true">
      <polyline
        points="0,12 14,12 19,4 25,20 31,12 45,12 50,4 56,20 62,12 76,12 81,4 87,20 93,12 107,12 112,4 118,20 120,12"
      />
    </svg>
    <span>{{ label }}</span>
  </div>
</template>

<style scoped>
/* Reuses the login page's oscilloscope-trace shape (see LoginPage.vue's
   .signal-trace-svg) at loader scale, and the sidebar live-dot's own
   `signal-pulse` keyframe (style.css) rather than inventing a third
   animation for the same "data crossing the bridge" idea. */
.signal-loader {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  color: var(--text-muted);
  font-size: var(--text-base);
  padding: var(--space-2) 0;
}
.signal-loader-svg {
  width: 2.75rem;
  height: 1rem;
  flex-shrink: 0;
  overflow: visible;
}
.signal-loader-svg polyline {
  fill: none;
  stroke: var(--signal);
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
  animation: signal-pulse 1.6s ease-in-out infinite;
}
</style>
