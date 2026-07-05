<script setup lang="ts">
import { useLiveSignal } from "@/composables/useLiveSignal";
import { Activity } from "lucide-vue-next";
import { useI18n } from "vue-i18n";

defineProps<{ navOpen: boolean }>();
const emit = defineEmits<{ "toggle-nav": [] }>();
const { t } = useI18n({ useScope: "global" });

const { isLive } = useLiveSignal();
</script>

<template>
  <header class="mobile-topbar">
    <button
      type="button"
      class="mobile-nav-toggle"
      :aria-expanded="navOpen"
      aria-controls="sidebar-nav"
      :aria-label="t('components.mobile_topbar.toggle_nav')"
      @click="emit('toggle-nav')"
    >
      <span aria-hidden="true">☰</span>
    </button>
    <div class="brand">
      <Activity
        class="brand-icon"
        :class="{ 'is-live': isLive }"
        :size="16"
        stroke-width="2.25"
        :title="isLive ? t('components.mobile_topbar.live_traffic') : t('components.mobile_topbar.no_recent_traffic')"
        aria-hidden="true"
      />
      MCP REST Bridge
    </div>
  </header>
</template>

<style scoped>
.mobile-topbar {
  display: none;
}
/* Shared brand look with TheSidebar.vue — duplicated here rather than
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
.brand-icon {
  color: var(--text-on-dark-muted);
  flex-shrink: 0;
}
.brand-icon.is-live {
  color: var(--signal);
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