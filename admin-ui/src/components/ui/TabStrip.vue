<script lang="ts">
// ARIA id helpers so a TabStrip and its tabpanel can cross-reference each other.
// The consumer passes `idBase` and builds its panel's id/aria-labelledby with
// these same helpers, so the two sides can never drift out of sync.
export function tabId(idBase: string, key: string): string {
  return `${idBase}-tab-${key}`;
}
export function tabPanelId(idBase: string): string {
  return `${idBase}-panel`;
}
</script>

<script setup lang="ts" generic="T extends string">
import { ref, type Component } from "vue";

const props = defineProps<{
  /**
   * `badge` marks a tab whose panel holds something the user should know about
   * without opening it — the count of configured policies, for instance. It
   * exists because grouping a long form into tabs otherwise hides state: a
   * policy set weeks ago in a tab nobody opens becomes invisible. Rendered
   * inside the tab's accessible name, so screen-reader users get it too.
   */
  tabs: { key: T; label: string; icon?: Component; badge?: string | number }[];
  ariaLabel?: string;
  // When set, each tab gets an `id` + `aria-controls` pointing at the shared
  // panel. The consumer must render its panel with `:id="tabPanelId(idBase)"`,
  // `role="tabpanel"` and `:aria-labelledby="tabId(idBase, activeKey)"`. Omit
  // when there's no single panel to associate — the tablist still gets the
  // full keyboard model regardless.
  idBase?: string;
}>();
const active = defineModel<T>({ required: true });

const tablistEl = ref<HTMLElement | null>(null);

function focusTabAt(index: number) {
  tablistEl.value?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[index]?.focus();
}

// WAI-ARIA tabs keyboard model with automatic activation (moving focus also
// selects the tab): ArrowLeft/ArrowRight move between tabs (wrapping),
// Home/End jump to the first/last tab.
function onTabKeydown(e: KeyboardEvent, index: number) {
  const count = props.tabs.length;
  let target: number;
  switch (e.key) {
    case "ArrowRight":
      target = (index + 1) % count;
      break;
    case "ArrowLeft":
      target = (index - 1 + count) % count;
      break;
    case "Home":
      target = 0;
      break;
    case "End":
      target = count - 1;
      break;
    default:
      return;
  }
  e.preventDefault();
  const nextTab = props.tabs[target];
  if (!nextTab) return;
  active.value = nextTab.key;
  focusTabAt(target);
}
</script>

<template>
  <div ref="tablistEl" class="tab-strip" role="tablist" :aria-label="ariaLabel">
    <button
      v-for="(tab, index) in tabs"
      :id="idBase ? tabId(idBase, tab.key) : undefined"
      :key="tab.key"
      type="button"
      role="tab"
      :aria-selected="active === tab.key"
      :aria-controls="idBase ? tabPanelId(idBase) : undefined"
      :tabindex="active === tab.key ? 0 : -1"
      class="tab-btn"
      :class="{ 'tab-active': active === tab.key }"
      @click="active = tab.key"
      @keydown="onTabKeydown($event, index)"
    >
      <component :is="tab.icon" v-if="tab.icon" :size="15" stroke-width="2" aria-hidden="true" />
      {{ tab.label }}
      <span v-if="tab.badge !== undefined" class="tab-badge">{{ tab.badge }}</span>
    </button>
  </div>
</template>

<style scoped>
.tab-strip {
  display: flex;
  gap: 0.25rem;
  margin-bottom: 1.25rem;
  border-bottom: 1px solid var(--border);
}
.tab-btn {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  background: none;
  border: none;
  border-bottom: 2px solid transparent;
  color: var(--text-secondary);
  font-weight: 600;
  font-size: 0.88rem;
  padding: 0.55rem 0.35rem;
  margin-bottom: -1px;
  cursor: pointer;
  transition:
    color 0.12s ease,
    border-color 0.12s ease;
}
.tab-btn:hover {
  color: var(--text-primary);
}
.tab-btn.tab-active {
  color: var(--signal-strong);
  border-bottom-color: var(--signal);
}
.tab-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 1.1rem;
  padding: 0 0.3rem;
  border-radius: var(--radius-pill);
  background: var(--surface-sunken);
  color: var(--text-secondary);
  font-size: var(--text-xs);
  font-weight: 700;
  line-height: 1.35;
}
.tab-btn.tab-active .tab-badge {
  background: var(--signal-soft);
  color: var(--signal-strong);
}
</style>
