<script setup lang="ts">
import { computed } from "vue";
import { useLiveSignal } from "@/composables/useLiveSignal";
import { GitBranch } from "lucide-vue-next";

defineProps<{ navOpen: boolean }>();
const emit = defineEmits<{ "toggle-nav": [] }>();

const { isLive, callsPerMinute } = useLiveSignal();

// Pulse speed scales with real recent call volume (never fabricated — callsPerMinute
// comes straight from useLiveSignal's poll of /admin-api/usage/summary) instead of a
// flat on/off blink, so the live dot reads as an actual traffic signal.
const pulseTier = computed<"slow" | "normal" | "fast" | null>(() => {
  if (!isLive.value) return null;
  if (callsPerMinute.value >= 15) return "fast";
  if (callsPerMinute.value >= 5) return "normal";
  return "slow";
});
</script>

<template>
  <header class="mobile-topbar">
    <button
      type="button"
      class="mobile-nav-toggle"
      :aria-expanded="navOpen"
      aria-controls="sidebar-nav"
      aria-label="Toggle navigation menu"
      @click="emit('toggle-nav')"
    >
      <span aria-hidden="true">☰</span>
    </button>
    <div class="brand">
      <GitBranch :size="16" stroke-width="2.25" aria-hidden="true" /> MCP REST Bridge
      <span
        class="live-dot"
        :class="{ 'is-live': isLive, [`pulse-${pulseTier}`]: pulseTier }"
        :title="isLive ? 'Live traffic in the last minute' : 'No recent traffic'"
        aria-hidden="true"
      ></span>
    </div>
  </header>
</template>

<style scoped>
.mobile-topbar {
  display: none;
}
/* Shared brand + live-dot look with TheSidebar.vue — duplicated here rather than
   factored into a sub-component since each copy is only ~10 lines. */
.brand {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-family: var(--font-display);
  font-weight: 600;
  font-size: var(--text-md);
  color: #fff;
  margin-bottom: var(--space-4);
  padding: 0 var(--space-1-5);
}
.brand svg {
  color: var(--signal);
  flex-shrink: 0;
}
.live-dot {
  width: 0.4375rem;
  height: 0.4375rem;
  border-radius: 50%;
  background: var(--text-on-dark-muted);
  margin-left: auto;
  flex-shrink: 0;
}
.live-dot.is-live {
  background: var(--signal);
  animation: signal-pulse 1.6s ease-in-out infinite;
}
.live-dot.is-live.pulse-slow {
  animation-duration: 2.4s;
}
.live-dot.is-live.pulse-fast {
  animation-duration: 0.85s;
}

@media (max-width: 768px) {
  .mobile-topbar {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    background: var(--ink);
    color: #fff;
    padding: var(--space-3) var(--space-4);
    position: sticky;
    top: 0;
    z-index: var(--z-mobile-topbar);
  }
  .mobile-topbar .brand {
    margin: 0;
    padding: 0;
  }
  .mobile-nav-toggle {
    background: none;
    border: 1px solid var(--ink-border);
    border-radius: var(--radius-sm);
    color: #fff;
    font-size: var(--text-lg);
    line-height: 1;
    padding: var(--space-1-5) var(--space-2);
    cursor: pointer;
  }
}
</style>
