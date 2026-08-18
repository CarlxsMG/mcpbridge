<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { useRoute, useRouter } from "vue-router";
import { navTabsOf } from "@/navigation";
import TabStrip, { tabId, tabPanelId } from "@/components/ui/TabStrip.vue";

const { t } = useI18n({ useScope: "global" });
const route = useRoute();
const router = useRouter();

const ID_BASE = "activity";

// Labels, icons and order all come from navigation.ts, where these entries
// already live for the router and the command palette. A second list here is
// exactly how a tab strip and its routes drift apart.
const tabEntries = navTabsOf("activity");
const tabs = computed(() =>
  tabEntries.map((entry) => ({ key: entry.name, label: t(entry.labelKey), icon: entry.icon })),
);
// The fallback selection, read below. Destructured rather than indexed so an
// empty tab list renders an empty strip instead of throwing during setup — this
// runs before anything is on screen, so a throw here blanks the page rather than
// degrading it.
const [firstTab] = tabEntries;

/**
 * The selected tab is read from and written to the ROUTE, never held in local
 * state: that is what makes a tab linkable, survive a reload, and come back
 * correctly from a drill-down page. Each tab is a child route whose name is the
 * tab key, so `route.name` IS the selection.
 *
 * Writing goes through `push` rather than `replace` so the browser's Back button
 * returns to the tab the user came from, which is what a tab click looks like
 * from the user's side — a navigation.
 */
const activeTab = computed<string>({
  get: () => (typeof route.name === "string" ? route.name : (firstTab?.name ?? "")),
  set: (name) => {
    void router.push({ name });
  },
});

// Deliberately no <h1> here. The tab strip is navigation, and the page the panel
// renders already owns the heading — leaving both would put two competing h1s on
// one page, and hoisting one here would mean rewriting all three panels.
</script>

<template>
  <div class="activity-shell">
    <TabStrip v-model="activeTab" :tabs="tabs" :id-base="ID_BASE" :aria-label="t('pages.activity.tabs_aria')" />
    <div :id="tabPanelId(ID_BASE)" class="activity-panel" role="tabpanel" :aria-labelledby="tabId(ID_BASE, activeTab)">
      <RouterView />
    </div>
  </div>
</template>

<style scoped>
/* The panel has to pass `.content`'s definite height down to the panel's own
   page, or the `.list-shell` / `.sticky-pagination` pair inside Traffic and
   Traces loses the full-height column it needs to hold the pager at the bottom
   of a short list. `:deep()` because that root element belongs to the routed
   child component. */
.activity-shell {
  display: flex;
  flex-direction: column;
  min-height: 100%;
}
.activity-panel {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}
.activity-panel :deep(.list-shell) {
  flex: 1;
}
</style>
