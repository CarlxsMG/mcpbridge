<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useRoute } from "vue-router";
import { useAuth } from "./composables/useAuth";
import { useLiveSignal } from "./composables/useLiveSignal";
// Side-effect-only imports: useTheme/useDensity/useLocale apply the saved
// theme/density/locale preference to the document at module-load time.
// App.vue is the one component guaranteed to be in every route's chunk
// graph, so importing them here (rather than only from AccountPage.vue,
// where the toggles live) is what makes the preference actually apply on a
// fresh load of any page, not just /account.
import "./composables/useTheme";
import "./composables/useDensity";
import "./composables/useLocale";
import SignalLoader from "@/components/ui/SignalLoader.vue";
import DemoRibbon from "./components/layout/DemoRibbon.vue";
import TheMobileTopbar from "./components/layout/TheMobileTopbar.vue";
import TheSidebar from "./components/layout/TheSidebar.vue";
import { routeAnnouncement } from "@/router";

const route = useRoute();
const { t } = useI18n({ useScope: "global" });
const { state } = useAuth();
const { start: startLiveSignal, stop: stopLiveSignal } = useLiveSignal();

const showShell = computed(() => state.user !== null);
const mobileNavOpen = ref(false);

watch(
  () => route.fullPath,
  () => {
    mobileNavOpen.value = false;
  },
);

watch(
  showShell,
  (shown) => {
    if (shown) {
      startLiveSignal();
    } else {
      stopLiveSignal();
    }
  },
  { immediate: true },
);

function onKeydown(e: KeyboardEvent) {
  if (e.key === "Escape" && mobileNavOpen.value) mobileNavOpen.value = false;
}
onMounted(() => window.addEventListener("keydown", onKeydown));
onUnmounted(() => {
  window.removeEventListener("keydown", onKeydown);
  stopLiveSignal();
});
</script>

<template>
  <a href="#main-content" class="skip-link">{{ t("common.skip_to_content") }}</a>
  <div class="sr-only" role="status" aria-live="polite" aria-atomic="true">{{ routeAnnouncement }}</div>
  <DemoRibbon />
  <div v-if="showShell" class="app-shell">
    <TheMobileTopbar :nav-open="mobileNavOpen" @toggle-nav="mobileNavOpen = !mobileNavOpen" />
    <div v-if="mobileNavOpen" class="mobile-nav-backdrop" @click="mobileNavOpen = false"></div>
    <TheSidebar :nav-open="mobileNavOpen" />
    <main id="main-content" class="content" tabindex="-1">
      <RouterView />
    </main>
  </div>
  <SignalLoader v-else-if="!state.checked" class="loading" />
  <RouterView v-else />
</template>

<style scoped>
.skip-link {
  position: absolute;
  left: -9999px;
  top: auto;
  z-index: var(--z-command-palette);
  background: var(--surface);
  color: var(--text-primary);
  padding: var(--space-2) var(--space-4);
  border-radius: var(--radius-sm);
  box-shadow: var(--shadow-md);
  font-size: var(--text-base);
  font-weight: 600;
  text-decoration: none;
}
.skip-link:focus {
  left: var(--space-4);
  top: var(--space-4);
}
/* `.sr-only` (route-announcement region above) is a global utility in style.css. */
.app-shell {
  display: flex;
  height: 100vh;
}
.loading {
  padding: var(--space-8);
  color: var(--text-muted);
}
.mobile-nav-backdrop {
  display: none;
}
.content {
  /* Fluid on purpose — no max-width cap. This is an observability/management
     surface: tables, charts and grids should use every pixel a big monitor or
     a wall TV offers. Readability at huge widths is handled by the root
     font-size ramp in style.css (the effective design width stays ~1920-2750px
     at any resolution) plus per-page max-widths on forms/prose, never by
     capping the shell itself. */
  flex: 1;
  width: 100%;
  height: 100%;
  overflow-y: auto;
  padding: var(--space-8) var(--space-10) 0;
  min-width: 0;
}
.content:focus {
  /* Focused programmatically after a route change to move the reading position,
     not because the region itself is an interactive control — so no focus ring. */
  outline: none;
}

@media (max-width: 768px) {
  .app-shell {
    display: block;
    height: auto;
  }
  .mobile-nav-backdrop {
    display: block;
    position: fixed;
    inset: 0;
    background: var(--overlay-backdrop);
    z-index: var(--z-mobile-backdrop);
  }
  .content {
    height: auto;
    overflow-y: visible;
    padding: var(--space-5) var(--space-4) 4.5rem;
    max-width: 100%;
  }
}
</style>
